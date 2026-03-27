# Backend autorestart after server reboot

**Without this, the backend does not start after a reboot.** Install and enable the systemd unit **once** - then it will start with the server and restart on crash.

## Option 1: systemd (recommended)

The backend starts with the system and is restarted automatically on crash.

```bash
# From the project directory /root/game
sudo cp scripts/pot-game-backend.service /etc/systemd/system/

# If the project lives elsewhere, edit the path:
# sudo nano /etc/systemd/system/pot-game-backend.service
# Set WorkingDirectory= e.g. /home/user/game/backend

sudo systemctl daemon-reload
sudo systemctl enable pot-game-backend   # important: start on boot
sudo systemctl start pot-game-backend
```

Useful commands:
- `sudo systemctl status pot-game-backend` - status
- `sudo systemctl restart pot-game-backend` - restart
- `sudo journalctl -u pot-game-backend -f` - live logs

### If you get 404 on /api/question or /api/sponsor-display-names after reboot

Usually the backend is not running (the service was not enabled or failed to start). Check:

```bash
sudo systemctl status pot-game-backend
```

If it is not “enabled”, enable and start:

```bash
sudo systemctl enable pot-game-backend
sudo systemctl start pot-game-backend
```

Also ensure your reverse proxy (nginx, etc.) forwards `https://game.mynode.uk/api/*` to the port where the backend listens (e.g. 3000).

## Option 2: cron @reboot

If you prefer not to use systemd:

```bash
crontab -e
```

Add a line (adjust path and user):

```
@reboot cd /root/game/backend && /usr/bin/node index.js >> /root/game/backend/log.txt 2>&1
```

Note: on crash the process will not restart until the next reboot.
