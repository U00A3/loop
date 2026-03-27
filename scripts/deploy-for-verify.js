/**
 * Deploy RedbellyCommunityPotGame on Redbelly Testnet
 * with a “verification-ready” compile (Standard JSON: RedbellyCommunityPotGame.sol, optimizer 200, no evmVersion).
 * Per Contract-verify.md - bytecode matches Routescan.
 */

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_NAME = "RedbellyCommunityPotGame";
const SOURCE_FILE = "RedbellyCommunityPotGame.sol";

function loadSource() {
  const p = path.join(__dirname, "..", "contracts", SOURCE_FILE);
  return fs.readFileSync(p, "utf8");
}

function compile() {
  const source = loadSource();
  const input = {
    language: "Solidity",
    sources: {
      [SOURCE_FILE]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode"],
        },
      },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: () => ({ contents: "" }) })
  );

  if (output.errors && output.errors.some((e) => e.severity === "error")) {
    throw new Error(
      output.errors.filter((e) => e.severity === "error").map((e) => e.formattedMessage).join("\n")
    );
  }

  const contract = output.contracts[SOURCE_FILE][CONTRACT_NAME];
  if (!contract) throw new Error("Contract not found in output");
  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object,
  };
}

function getConstructorArgs() {
  const quizSigner = process.env.POT_QUIZ_SIGNER || process.env.BACKEND_ADDRESS;
  const operator = process.env.POT_OPERATOR || process.env.BACKEND_ADDRESS;
  const resetFee = process.env.POT_RESET_FEE || "5000000000000000000"; // 5 RBNT
  if (!quizSigner || !operator) {
    throw new Error("Set POT_QUIZ_SIGNER, POT_OPERATOR (or BACKEND_ADDRESS) in .env");
  }
  return {
    quizSigner: ethers.getAddress(quizSigner),
    operator: ethers.getAddress(operator),
    resetFee: BigInt(resetFee),
  };
}

async function main() {
  const rpc = process.env.RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !pk) throw new Error("Set RPC_URL and DEPLOYER_PRIVATE_KEY in .env");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);

  const { abi, bytecode } = compile();
  const args = getConstructorArgs();

  const factory = new ethers.ContractFactory(abi, "0x" + bytecode, wallet);
  const contract = await factory.deploy(args.quizSigner, args.operator, args.resetFee);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("Deployed RedbellyCommunityPotGame:", address);
  console.log("Network:", process.env.RPC_URL);
  console.log("Constructor args: quizSigner=%s operator=%s resetFee=%s (5 RBNT)", args.quizSigner, args.operator, args.resetFee.toString());
  console.log("\nWeryfikacja na Routescan:");
  console.log("  Contract name: RedbellyCommunityPotGame.sol:RedbellyCommunityPotGame");
  console.log("  Compiler: 0.8.20, Optimizer enabled, Runs 200, EVM version: default (puste)");
  const abiCoder = new ethers.AbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "uint256"],
    [args.quizSigner, args.operator, args.resetFee]
  );
  console.log("  Constructor arguments (hex, bez 0x):", encoded.slice(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
