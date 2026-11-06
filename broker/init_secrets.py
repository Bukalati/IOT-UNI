"""Create local, ignored broker users for the fixed Phase 01 demo identities."""
import json
import secrets
import subprocess
from pathlib import Path

root = (Path(__file__).parent / "secrets").resolve()
root.mkdir(parents=True, exist_ok=True)
password_file = root / "passwords"
if password_file.exists():
    raise SystemExit("Credentials already exist; remove them deliberately before regenerating.")

credentials = {
    user: secrets.token_urlsafe(24)
    for user in ("backend", "device-plant-01", "simulator-demo-01")
}
for index, (user, password) in enumerate(credentials.items()):
    subprocess.run(
        ["docker", "run", "--rm", "-v", f"{root}:/secrets",
         "--entrypoint", "mosquitto_passwd", "eclipse-mosquitto:2.0.22",
         *(["-c"] if index == 0 else []), "-b", "/secrets/passwords", user, password],
        check=True, stdout=subprocess.DEVNULL,
    )
subprocess.run(
    ["docker", "run", "--rm", "-v", f"{root}:/secrets", "--entrypoint", "chown",
     "eclipse-mosquitto:2.0.22", "1883:1883", "/secrets/passwords"], check=True,
)
subprocess.run(
    ["docker", "run", "--rm", "-v", f"{root}:/secrets", "--entrypoint", "chmod",
     "eclipse-mosquitto:2.0.22", "600", "/secrets/passwords"], check=True,
)
credential_path = root / "test-credentials.json"
credential_path.write_text(json.dumps(credentials))
credential_path.chmod(0o600)
print("Created ignored broker credentials for three demo users.")
