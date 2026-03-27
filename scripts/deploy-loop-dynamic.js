/**
 * Deploy contract from RedbellyCommunityLoopDynamic.sol (dynamic reset fee: 5/10/15 RBNT).
 * Constructor: quizSigner, operator, baseResetFee (base in wei, e.g. 5 RBNT).
 * POT_RESET_FEE in .env = baseResetFee (5 RBNT); currentResetFee() returns 5/10/15 RBNT depending on time.
 */

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", "backend", ".env") });

const CONTRACT_NAME = "RedbellyCommunityPotGame";
const SOURCE_FILE = "RedbellyCommunityLoopDynamic.sol";

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
  // baseResetFee w wei (np. 5 RBNT); currentResetFee() zwraca 5/10/15 RBNT
  const baseResetFee = process.env.POT_RESET_FEE || "5000000000000000000";
  if (!quizSigner || !operator) {
    throw new Error("Set POT_QUIZ_SIGNER, POT_OPERATOR (or BACKEND_ADDRESS) in .env");
  }
  return {
    quizSigner: ethers.getAddress(quizSigner),
    operator: ethers.getAddress(operator),
    baseResetFee: BigInt(baseResetFee),
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
  const contract = await factory.deploy(args.quizSigner, args.operator, args.baseResetFee);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("Deployed (RedbellyCommunityLoopDynamic.sol):", address);
  console.log("Network:", process.env.RPC_URL);
  console.log("Constructor args: quizSigner=%s operator=%s baseResetFee=%s (5 RBNT base → currentResetFee() 5/10/15 RBNT)", args.quizSigner, args.operator, args.baseResetFee.toString());
  const abiCoder = new ethers.AbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "uint256"],
    [args.quizSigner, args.operator, args.baseResetFee]
  );
  console.log("\nConstructor arguments (hex, bez 0x):", encoded.slice(2));
  console.log("\nDodaj do .env: POT_GAME_CONTRACT_ADDRESS=" + address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
