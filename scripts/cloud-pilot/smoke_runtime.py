"""Secret-free CI only: boot the packaged server with the cloud worker disabled."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request


def main():
    binary = Path("/tmp/t3-pilot-runtime/dist/bin.mjs")
    with tempfile.TemporaryDirectory(prefix="t3-pilot-smoke-") as directory:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(
                ["node", str(binary), "serve", "--host", "127.0.0.1", "--port", str(port), "--base-dir", directory],
                cwd=directory, stdout=output, stderr=output,
                env={**os.environ, "T3_CLOUD_PILOT_ENABLED": "disabled"},
            )
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError("Packaged server exited before readiness")
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=0.5) as response:
                            if response.status == 200:
                                print("Packaged server reached HTTP readiness with live worker disabled")
                                return
                    except (OSError, TimeoutError):
                        pass
                    time.sleep(0.25)
                raise RuntimeError("Packaged server readiness timed out")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
