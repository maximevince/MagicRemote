#!/usr/bin/env python3
"""MagicRemote M0 protocol spike: capture and experiment on a real Blackmagic camera (Linux/BlueZ).

Runs a scripted session against one camera and logs every packet, in and out, as JSONL.

  m0.py --addr CC:86:EC:00:00:01 [--pair] [--log out.jsonl] [--do ACTION ...]

Actions (run in order after subscribing):
  wait:S                 keep listening for S seconds
  rec:R:start|stop       record via recipe R = A | Ap (A-prime) | B, then report the 10.1 echo
  power:on|off           write Camera Status 0x01 / 0x00
  raw:HEX                write raw bytes to Outgoing Camera Control
  slate:TEXT             write 12.8 project name (long-write / MTU test)
  resub                  stop + restart all notifications (does the burst come again?)
  read-status            read Camera Status

Passkey: when BlueZ asks for the camera's PIN, this script's agent waits for a file
~/magicremote-m0/passkey containing the 6 digits shown on the camera, or with --pin-tty asks for it
on the terminal (the person at the camera types it themselves; needs `ssh -t`).

--strict is for reconnect tests: a passkey request means the camera did not honour the bond, so the
agent rejects it at once and the run stops (exit 6) instead of starting yet another pairing.
Exit 7 = connected but nothing arrived on the encrypted characteristics.
"""
import argparse, asyncio, json, os, struct, sys, time
from pathlib import Path

from bleak import BleakClient, BleakScanner
from dbus_fast import BusType, DBusError, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, method

SVC = "291d567a-6d75-11e6-8b77-86f30ca893d3"
OUT = "5dd3465f-1aee-4299-8493-d2eca2f8e1bb"
INC = "b864e140-76a0-416a-bf30-5876504537d9"
TC = "6d8f2110-86f1-41bf-9afb-451d87e976c8"
STATUS = "7fe8691d-95dc-4fc5-8abd-ca74339b51b9"
NAME = "ffac0c52-c9fb-41a0-b063-cc76282eb89c"
PROTO = "8f1fd018-b508-456f-8f82-3d392bee2706"
MODEL = "00002a24-0000-1000-8000-00805f9b34fb"
MANUF = "00002a29-0000-1000-8000-00805f9b34fb"
CHARNAMES = {INC: "incoming", TC: "timecode", STATUS: "status"}

PASSKEY_FILE = Path.home() / "magicremote-m0" / "passkey"
T0 = time.monotonic()
LOG = None
last_transport = None  # last 10.1 data bytes (int8 list)
transport_events = []  # (t, data)


def log(kind, **kw):
    rec = {"t": round(time.monotonic() - T0, 4), "kind": kind, **kw}
    line = json.dumps(rec)
    print(line, flush=True)
    if LOG:
        LOG.write(line + "\n")
        LOG.flush()


# ---------------------------------------------------------------- protocol helpers
TYPES = {0: ("void", 0), 1: ("int8", 1), 2: ("int16", 2), 3: ("int32", 4), 4: ("int64", 8), 5: ("string", 1), 128: ("fixed16", 2)}


def plausible(buf, i, strict=True):
    """Looks like a packet header at i: [dest, len>=4, cmd=0, ?] and the packet fits."""
    if i + 8 > len(buf) or buf[i + 2] != 0 or buf[i + 1] < 4 or i + 4 + buf[i + 1] > len(buf):
        return False
    return buf[i] == 0xFF or not strict


def split(buf):
    """Split a (possibly concatenated) indication into packets. Tries padded, then unpadded."""
    out, i = [], 0
    while plausible(buf, i, strict=False):
        n = 4 + buf[i + 1]
        out.append(bytes(buf[i:i + n]))
        padded, raw = i + ((n + 3) & ~3), i + n
        if padded >= len(buf) and raw >= len(buf):
            return out, b""
        # prefer a broadcast (0xFF) header; padded first, then unpadded
        if plausible(buf, padded):
            i = padded
        elif plausible(buf, raw):
            i = raw
        else:
            i = padded if plausible(buf, padded, strict=False) else raw
    return out, bytes(buf[i:])


def decode(p):
    g, prm, ty, op = p[4], p[5], p[6], p[7]
    data = p[8:]
    if ty not in TYPES:  # unknown / device-specific data type: keep the raw bytes
        return {"id": f"{g}.{prm}", "type": f"t{ty}", "op": op, "raw": data.hex()}
    name, size = TYPES[ty]
    if name == "string":
        vals = data.decode("utf-8", "replace")
    elif name == "void":
        vals = list(data)  # booleans are sent as void + one byte
    else:
        fmt = {"int8": "b", "int16": "h", "int32": "i", "int64": "q", "fixed16": "h"}[name]
        cnt = len(data) // size
        vals = list(struct.unpack("<" + fmt * cnt, data[: cnt * size]))
        if name == "fixed16":
            vals = [round(v / 2048, 4) for v in vals]
    return {"id": f"{g}.{prm}", "type": name, "op": op, "values": vals}


def packet(group, param, typ, values, op=0):
    name, size = TYPES[typ]
    if name == "string":
        data = values.encode()
    elif name == "void":
        data = bytes(values)  # [] for a trigger, [0|1] for a boolean
    else:
        fmt = {"int8": "b", "int16": "h", "int32": "i", "int64": "q", "fixed16": "h"}[name]
        data = struct.pack("<" + fmt * len(values), *values)
    body = bytes([group, param, typ, op]) + data
    pkt = bytes([0xFF, len(body), 0, 0]) + body
    return pkt + b"\0" * ((-len(pkt)) % 4)


def decode_tc(b):
    if len(b) < 12:
        return None
    u = struct.unpack("<I", bytes(b[8:12]))[0]
    sep = ";" if u & 0x80000000 else ":"
    return f"{(u >> 24) & 0x3F:02x}{sep}{(u >> 16) & 0xFF:02x}{sep}{(u >> 8) & 0xFF:02x}{sep}{u & 0xFF:02x}"


def record_packet(recipe, mode):
    if recipe == "B" or last_transport is None:
        if recipe != "B":
            log("note", msg=f"no 10.1 seen yet, recipe {recipe} falls back to B")
        return bytes([0xFF, 5, 0, 0, 10, 1, 1, 0, mode, 0, 0, 0])
    data = list(last_transport)
    data[0] = mode
    if recipe == "Ap":
        data[1] = 0
        data[2] &= ~0x03 & 0xFF
    return packet(10, 1, 1, [v if v < 128 else v - 256 for v in data])


# ---------------------------------------------------------------- BlueZ pairing agent
class Agent(ServiceInterface):
    def __init__(self, pin_tty=False, strict=False):
        super().__init__("org.bluez.Agent1")
        self.pin_tty, self.strict, self.passkey_requests = pin_tty, strict, 0

    @staticmethod
    def ask_tty():
        with open("/dev/tty", "r") as ti, open("/dev/tty", "w") as to:
            while True:
                to.write("\n>>> Type the 6-digit PIN shown on the camera, then Enter: ")
                to.flush()
                txt = ti.readline().strip().replace(" ", "")
                if txt.isdigit() and len(txt) == 6:
                    to.write("    sent, waiting for the camera...\n")
                    to.flush()
                    return int(txt)
                to.write("    that is not 6 digits\n")
                to.flush()

    @method()
    def Release(self):
        log("agent", ev="Release")

    @method()
    async def RequestPasskey(self, device: "o") -> "u":
        self.passkey_requests += 1
        if self.strict:
            log("agent", ev="RequestPasskey", device=device, msg="UNEXPECTED: camera wants a new pairing; rejecting")
            raise DBusError("org.bluez.Error.Rejected", "bond expected, not pairing again")
        if self.pin_tty:
            log("agent", ev="RequestPasskey", device=device, msg="asking on the terminal")
            pk = await asyncio.get_running_loop().run_in_executor(None, self.ask_tty)
            log("agent", ev="PasskeyProvided")
            return pk
        log("agent", ev="RequestPasskey", device=device, msg=f"waiting for {PASSKEY_FILE}")
        asked = time.time()
        try:
            for _ in range(1800):
                if PASSKEY_FILE.exists() and PASSKEY_FILE.stat().st_mtime < asked:
                    log("agent", ev="StalePasskeyIgnored")  # written before this request: old PIN
                    PASSKEY_FILE.unlink(missing_ok=True)
                if PASSKEY_FILE.exists():
                    txt = PASSKEY_FILE.read_text().strip()
                    log("agent", ev="PasskeyFileSeen", length=len(txt))
                    if txt.isdigit() and len(txt) == 6:
                        PASSKEY_FILE.unlink(missing_ok=True)
                        log("agent", ev="PasskeyProvided")
                        return int(txt)
                await asyncio.sleep(0.1)
            raise Exception("passkey timeout")
        except Exception as e:
            log("agent", ev="RequestPasskeyError", err=repr(e))
            raise

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        log("agent", ev="RequestPinCode", device=device)
        return PASSKEY_FILE.read_text().strip() if PASSKEY_FILE.exists() else "000000"

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):
        log("agent", ev="DisplayPasskey", passkey=passkey)

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):
        log("agent", ev="DisplayPinCode", pincode=pincode)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):
        log("agent", ev="RequestConfirmation", passkey=passkey)

    @method()
    def RequestAuthorization(self, device: "o"):
        log("agent", ev="RequestAuthorization")

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):
        log("agent", ev="AuthorizeService", uuid=uuid)

    @method()
    def Cancel(self):
        log("agent", ev="Cancel")


async def register_agent(capability, **kw):
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    path = "/magicremote/m0agent"
    agent = Agent(**kw)
    bus.export(path, agent)
    intro = await bus.introspect("org.bluez", "/org/bluez")
    mgr = bus.get_proxy_object("org.bluez", "/org/bluez", intro).get_interface("org.bluez.AgentManager1")
    await mgr.call_register_agent(path, capability)
    await mgr.call_request_default_agent(path)
    log("agent", ev="registered", capability=capability)
    return bus, mgr, path, agent


# ---------------------------------------------------------------- session
async def main():
    global LOG, last_transport
    ap = argparse.ArgumentParser()
    ap.add_argument("--addr", required=True)
    ap.add_argument("--pair", action="store_true")
    ap.add_argument("--agent", default="KeyboardOnly")
    ap.add_argument("--name", default="MagicRemote M0")
    ap.add_argument("--adapter", default=None, help="BlueZ adapter, e.g. hci1")
    ap.add_argument("--pin-tty", action="store_true", help="ask for the PIN on the terminal")
    ap.add_argument("--strict", action="store_true", help="reconnect test: never pair, stop on a passkey request")
    ap.add_argument("--log")
    ap.add_argument("--do", nargs="*", default=["wait:10"])
    a = ap.parse_args()
    import fcntl
    lockf = open(PASSKEY_FILE.parent / ".m0.lock", "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("error", msg="another m0.py run is active; refusing to start")
        return 5
    if a.log:
        LOG = open(a.log, "a")

    bus, mgr, apath, agent = await register_agent(a.agent, pin_tty=a.pin_tty, strict=a.strict)
    n_in = 0
    c = None
    try:
        dev = await BleakScanner.find_device_by_address(a.addr, timeout=90, **({"bluez": {"adapter": a.adapter}} if a.adapter else {}))
        if not dev:
            log("error", msg="camera not found while scanning (connected elsewhere, off, or out of range?)")
            return 2
        log("found", name=dev.name)

        def on_disc(_):
            log("disconnected")

        # A pairing left pending by an interrupted run makes every connect fail with "InProgress".
        # ONLY when about to pair: with no pairing pending, BlueZ 5.87 answers CancelPairing by
        # sending MGMT Unpair Device, which wipes the kernel's LTK while bluetoothd still says
        # "Paired: yes". Doing this before a reconnect is what broke every reconnect on 2026-11-17.
        dpath = f"/org/bluez/{a.adapter or 'hci0'}/dev_" + a.addr.upper().replace(":", "_")
        try:
            if not a.pair:
                raise RuntimeError("keep the bond")
            dintro = await bus.introspect("org.bluez", dpath)
            await bus.get_proxy_object("org.bluez", dpath, dintro).get_interface("org.bluez.Device1").call_cancel_pairing()
            log("note", msg="cancelled a stale pending pairing")
        except Exception:
            pass
        c = BleakClient(dev, disconnected_callback=on_disc, timeout=30, **({"bluez": {"adapter": a.adapter}} if a.adapter else {}))
        for attempt in range(1, 7):
            try:
                await c.connect()
                break
            except Exception as e:  # weak signal / BlueZ "InProgress": back off and retry
                log("connect-retry", attempt=attempt, err=repr(e)[:160])
                if agent.passkey_requests and a.strict:
                    log("error", msg="bond NOT used: a new pairing was started on reconnect")
                    return 6
                await asyncio.sleep(3)
        else:
            log("error", msg="could not connect")
            return 3
        if True:  # connected; disconnected in the finally below
            log("connected", mtu=c.mtu_size)
            for u, k in ((MANUF, "manufacturer"), (MODEL, "model"), (PROTO, "protocol")):
                v = await c.read_gatt_char(u)
                log("read", what=k, value=bytes(v).rstrip(b"\0").decode(errors="replace"), hex=bytes(v).hex())
            await c.write_gatt_char(NAME, a.name.encode()[:32], response=True)
            log("out", what="device-name", value=a.name)

            if a.pair:
                log("pairing", msg="calling Pair(); camera should show a PIN")
                try:
                    await asyncio.wait_for(c.pair(), timeout=60)
                except Exception as e:
                    log("error", msg="pairing failed or timed out", err=repr(e)[:160])
                    return 4
                log("paired")
                try:  # bleak marks the device Trusted, which makes BlueZ reconnect it in the background
                    dintro = await bus.introspect("org.bluez", dpath)
                    props = bus.get_proxy_object("org.bluez", dpath, dintro).get_interface("org.freedesktop.DBus.Properties")
                    await props.call_set("org.bluez.Device1", "Trusted", Variant("b", False))
                except Exception as e:
                    log("note", msg="could not clear Trusted", err=repr(e)[:120])

            pending = bytearray()

            def on_ind(ch, data):
                nonlocal pending, n_in
                global last_transport
                n_in += 1
                cname = CHARNAMES.get(str(ch.uuid), str(ch.uuid))
                raw = bytes(data)
                if cname == "timecode":
                    log("in", ch=cname, hex=raw.hex(), tc=decode_tc(raw))
                    return
                if cname == "status":
                    log("in", ch=cname, hex=raw.hex(), bits=f"{raw[0]:08b}" if raw else None)
                    return
                pkts, rest = split(raw)
                log("in", ch=cname, len=len(raw), hex=raw.hex(), packets=[decode(p) for p in pkts], rest=rest.hex() or None)
                for p in pkts:
                    if p[4] == 10 and p[5] == 1:
                        last_transport = list(p[8:])
                        transport_events.append((time.monotonic(), last_transport))

            async def subscribe():
                for u in (STATUS, INC, TC):
                    t = time.monotonic()
                    await c.start_notify(u, on_ind)
                    log("subscribed", ch=CHARNAMES[u], took=round(time.monotonic() - t, 3))

            await subscribe()

            for act in a.do:
                kind, _, arg = act.partition(":")
                if kind == "wait":
                    await asyncio.sleep(float(arg))
                elif kind == "rec":
                    recipe, _, what = arg.partition(":")
                    mode = 2 if what == "start" else 0
                    pkt = record_packet(recipe, mode)
                    n0 = len(transport_events)
                    t = time.monotonic()
                    await c.write_gatt_char(OUT, pkt, response=True)
                    ack = time.monotonic()
                    log("out", what=f"rec {recipe} {what}", hex=pkt.hex(), ack_ms=round((ack - t) * 1000))
                    for _ in range(80):
                        if any(d and d[0] == mode for _, d in transport_events[n0:]):
                            break
                        await asyncio.sleep(0.05)
                    hit = [(round((tt - ack) * 1000), d) for tt, d in transport_events[n0:]]
                    log("result", what=f"rec {recipe} {what}", confirmed=any(d and d[0] == mode for _, d in hit), echoes_ms_after_ack=hit)
                elif kind == "power":
                    v = bytes([1 if arg == "on" else 0])
                    await c.write_gatt_char(STATUS, v, response=True)
                    log("out", what=f"power {arg}", hex=v.hex())
                elif kind == "raw":
                    b = bytes.fromhex(arg)
                    await c.write_gatt_char(OUT, b, response=True)
                    log("out", what="raw", hex=b.hex())
                elif kind == "slate":
                    pkt = packet(12, 8, 5, arg)
                    try:
                        await c.write_gatt_char(OUT, pkt, response=True)
                        log("out", what="slate project", len=len(pkt), hex=pkt.hex())
                    except Exception as e:
                        log("error", what="slate project", len=len(pkt), err=repr(e))
                elif kind == "resub":
                    for u in (STATUS, INC, TC):
                        await c.stop_notify(u)
                    log("unsubscribed")
                    await subscribe()
                elif kind == "read-status":
                    v = await c.read_gatt_char(STATUS)
                    log("read", what="status", hex=bytes(v).hex())
                else:
                    log("error", msg=f"unknown action {act}")
            log("done", indications=n_in, passkey_requests=agent.passkey_requests)
            if a.strict and agent.passkey_requests:
                log("error", msg="bond NOT honoured: camera asked for a new pairing")
                return 6
            if a.strict and not n_in:
                log("error", msg="connected, but nothing arrived on the encrypted characteristics")
                return 7
    finally:
        try:
            if c is not None and c.is_connected:
                await c.disconnect()
        except Exception:
            pass
        try:
            await mgr.call_unregister_agent(apath)
        except Exception:
            pass
        bus.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
