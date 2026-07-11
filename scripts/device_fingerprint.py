#!/usr/bin/env python3
import uuid
import os
import platform
import hashlib
import json
import socket

MEMFILE = os.path.expanduser("~/.haksterai_uid.json")

def get_os_info():
    """
    Detect real OS when running locally.
    Detect browser environment when sandboxed.
    """
    sys = platform.system().lower()

    # Browser sandbox detection
    if "emscripten" in sys or "javascript" in sys:
        return {
            "type": "browser",
            "details": platform.platform()
        }

    return {
        "type": "os",
        "name": sys,
        "release": platform.release(),
        "version": platform.version(),
        "platform": platform.platform()
    }

def get_mac_hash():
    """
    Hash MAC so you don't expose raw hardware address.
    """
    try:
        mac = uuid.getnode()
        mac_str = f"{mac:012x}"
        return hashlib.sha256(mac_str.encode()).hexdigest()
    except:
        return None

def generate_device_uid():
    """
    Stable UID stored locally.
    If file exists, reuse it.
    """
    if os.path.exists(MEMFILE):
        with open(MEMFILE, "r") as f:
            return json.load(f)

    device_uid = {
        "device_id": str(uuid.uuid4()),
        "created": platform.platform()
    }

    with open(MEMFILE, "w") as f:
        json.dump(device_uid, f)

    return device_uid

def session_uid():
    """
    New UID each run.
    """
    return str(uuid.uuid4())

def fingerprint():
    """
    Full fingerprint bundle for HaksterAI.
    """
    return {
        "device_uid": generate_device_uid(),
        "session_uid": session_uid(),
        "hostname": socket.gethostname(),
        "mac_hash": get_mac_hash(),
        "os": get_os_info()
    }

if __name__ == "__main__":
    print(json.dumps(fingerprint(), indent=4))