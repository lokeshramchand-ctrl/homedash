#!/usr/bin/env python3
"""Phone steering wheel for Euro Truck Simulator 2 (or any game that takes a gamepad).

The phone page (served from here over HTTPS) sends tilt + pedals + buttons over a
WebSocket. This script feeds them into a virtual Xbox 360 controller (ViGEmBus),
so the game just sees a normal gamepad.

    python server.py            # real mode, Windows + ViGEmBus
    python server.py --dry-run  # no controller, prints what it receives (any OS)
"""
from __future__ import annotations

import argparse
import datetime
import ipaddress
import json
import socket
import ssl
import sys
from pathlib import Path

from aiohttp import WSMsgType, web

HERE = Path(__file__).parent
CERT_DIR = HERE / ".certs"

# Button name (sent by the phone) -> vgamepad XUSB button name
BUTTONS = {
    "a": "XUSB_GAMEPAD_A",
    "b": "XUSB_GAMEPAD_B",
    "x": "XUSB_GAMEPAD_X",
    "y": "XUSB_GAMEPAD_Y",
    "lb": "XUSB_GAMEPAD_LEFT_SHOULDER",
    "rb": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "up": "XUSB_GAMEPAD_DPAD_UP",
    "down": "XUSB_GAMEPAD_DPAD_DOWN",
    "left": "XUSB_GAMEPAD_DPAD_LEFT",
    "right": "XUSB_GAMEPAD_DPAD_RIGHT",
    "start": "XUSB_GAMEPAD_START",
    "back": "XUSB_GAMEPAD_BACK",
}


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


class Pad:
    """Wraps vgamepad, or just logs in dry-run mode."""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.held: set[str] = set()
        self.last = None
        if dry_run:
            self.gp = None
            self.codes = {}
            return
        try:
            import vgamepad as vg
        except Exception as e:  # ImportError, or driver missing
            sys.exit(
                f"Could not start the virtual controller: {e}\n"
                "Install vgamepad + the ViGEmBus driver (see README), or use --dry-run."
            )
        self.gp = vg.VX360Gamepad()
        self.codes = {n: getattr(vg.XUSB_BUTTON, x) for n, x in BUTTONS.items()}

    def apply(self, steer: float, throttle: float, brake: float, buttons: set[str]) -> None:
        steer = clamp(steer, -1.0, 1.0)
        throttle = clamp(throttle, 0.0, 1.0)
        brake = clamp(brake, 0.0, 1.0)
        state = (round(steer, 3), round(throttle, 3), round(brake, 3), frozenset(buttons))
        if state == self.last:
            return
        self.last = state
        if self.dry_run:
            print(f"steer={steer:+.2f} gas={throttle:.2f} brake={brake:.2f} btn={sorted(buttons) or '-'}")
            return
        gp = self.gp
        gp.left_joystick_float(x_value_float=steer, y_value_float=0.0)
        gp.right_trigger_float(value_float=throttle)
        gp.left_trigger_float(value_float=brake)
        for name in buttons - self.held:
            gp.press_button(button=self.codes[name])
        for name in self.held - buttons:
            gp.release_button(button=self.codes[name])
        self.held = set(buttons)
        gp.update()

    def neutral(self) -> None:
        self.last = None
        self.apply(0.0, 0.0, 0.0, set())


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def make_cert(ip: str) -> tuple[Path, Path]:
    """Self-signed cert. Phone sensors only work on https, so we need one."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    CERT_DIR.mkdir(exist_ok=True)
    cert_path, key_path = CERT_DIR / f"cert-{ip}.pem", CERT_DIR / f"key-{ip}.pem"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "phone-wheel")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(ip)), x509.DNSName("localhost")]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


def parse_message(raw: str) -> tuple[float, float, float, set[str]] | None:
    try:
        d = json.loads(raw)
        steer, gas, brake = float(d["s"]), float(d["t"]), float(d["b"])
        btns = {b for b in d.get("btn", []) if b in BUTTONS}
        return steer, gas, brake, btns
    except (ValueError, KeyError, TypeError):
        return None


async def index(_: web.Request) -> web.FileResponse:
    return web.FileResponse(HERE / "static" / "index.html", headers={"Cache-Control": "no-store"})


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=5)
    await ws.prepare(request)
    pad: Pad = request.app["pad"]
    print(f"phone connected: {request.remote}")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                parsed = parse_message(msg.data)
                if parsed:
                    pad.apply(*parsed)
    finally:
        pad.neutral()  # never leave the truck flat out if the phone drops
        print("phone disconnected")
    return ws


def build_app(pad: Pad) -> web.Application:
    app = web.Application()
    app["pad"] = pad
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--dry-run", action="store_true", help="don't create a virtual controller, just print input")
    ap.add_argument("--no-tls", action="store_true", help="plain http (phone sensors will NOT work; testing only)")
    args = ap.parse_args()

    ip = lan_ip()
    ctx = None
    if not args.no_tls:
        cert, key = make_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
    scheme = "http" if args.no_tls else "https"
    print(f"\nOpen this on your phone (same Wi-Fi):\n\n    {scheme}://{ip}:{args.port}\n")
    if ctx:
        print("Chrome will warn about the certificate: Advanced -> Proceed. That is expected.\n")
    web.run_app(build_app(Pad(args.dry_run)), host="0.0.0.0", port=args.port, ssl_context=ctx, print=None)


if __name__ == "__main__":
    main()
