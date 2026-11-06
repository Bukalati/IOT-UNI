"""Integration check against a running local Compose broker and ignored test credentials."""
import json
import subprocess
import time
from pathlib import Path

credentials = json.loads((Path(__file__).parent / "secrets/test-credentials.json").read_text())
container = "home-broker-1"
physical = "irrigation/v1/devices/plant-01"
simulated = "irrigation/v1/simulations/demo-01/devices/sim-plant-01"

cases = [
    ("device-plant-01", f"{physical}/telemetry", True),
    ("device-plant-01", f"{physical}/commands", False),
    ("device-plant-01", f"{simulated}/telemetry", False),
    ("simulator-demo-01", f"{simulated}/telemetry", True),
    ("simulator-demo-01", f"{physical}/telemetry", False),
    ("backend", f"{physical}/commands", True),
    ("backend", f"{simulated}/commands", True),
    ("backend", f"{physical}/telemetry", False),
]

for user, topic, allowed in cases:
    result = subprocess.run(
        ["docker", "exec", container, "mosquitto_pub", "-V", "mqttv5", "-q", "1",
         "-h", "127.0.0.1", "-u", user, "-P", credentials[user],
         "-t", topic, "-m", "{}"],
        capture_output=True, text=True, check=False,
    )
    denied = "Not authorized" in result.stderr
    assert result.returncode == 0, (user, topic, result.stderr)
    assert denied != allowed, (user, topic, allowed, result.stderr)
    print(f"{'PASS' if allowed else 'DENIED'} {user} {topic}")

deliveries = [
    ("backend", "device-plant-01", f"{physical}/telemetry", True),
    ("simulator-demo-01", "device-plant-01", f"{physical}/telemetry", False),
    ("device-plant-01", "backend", f"{physical}/commands", True),
    ("simulator-demo-01", "backend", f"{physical}/commands", False),
]
for subscriber, publisher, topic, allowed in deliveries:
    receiver = subprocess.Popen(
        ["docker", "exec", container, "mosquitto_sub", "-V", "mqttv5", "-C", "1", "-W", "2",
         "-h", "127.0.0.1", "-u", subscriber, "-P", credentials[subscriber], "-t", topic],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    time.sleep(0.15)
    sent = subprocess.run(
        ["docker", "exec", container, "mosquitto_pub", "-V", "mqttv5", "-q", "1",
         "-h", "127.0.0.1", "-u", publisher, "-P", credentials[publisher],
         "-t", topic, "-m", "acl-probe"],
        capture_output=True, text=True, check=True,
    )
    assert "Not authorized" not in sent.stderr, (publisher, topic)
    received, _ = receiver.communicate(timeout=4)
    assert (received.strip() == "acl-probe") == allowed, (subscriber, topic, received)
    print(f"{'RECEIVED' if allowed else 'FILTERED'} {subscriber} {topic}")
