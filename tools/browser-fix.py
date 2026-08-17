#!/usr/bin/env python3
"""
browser-fix.py — Fix Chrome WS endpoint and launch Firefox with remote debugging.
Kills stale processes, restarts Chrome for Playwright MCP, launches Firefox with debug port.
"""
import os, subprocess, sys, time, socket, signal, urllib.request, json

CHROME_BIN = "/home/ghost/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
FIREFOX_BIN = "/usr/bin/firefox"
FIREFOX_PROFILE = "/home/ghost/.mozilla/firefox/32de33i2.default-release"
CHROME_PORT = 9222
FIREFOX_PORT = 9223
GHOST_UID = 1000
GHOST_GID = 1000

def kill_stale():
    """Kill all stale Chrome and Firefox processes."""
    for pattern in ["chromium-1228", "playwright-mcp", "firefox.*remote-debugging"]:
        try:
            subprocess.run(["pkill", "-9", "-f", pattern], timeout=5, capture_output=True)
        except Exception:
            pass
    time.sleep(1)
    print("✓ Killed stale processes")

def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0

def wait_port(port, timeout=15):
    for i in range(timeout):
        if not port_free(port):
            return True
        time.sleep(1)
    return False

def launch_chrome():
    """Launch Chrome with remote debugging for Playwright MCP."""
    if not os.path.isfile(CHROME_BIN):
        print(f"✗ Chrome not found: {CHROME_BIN}")
        return None
    
    cmd = [
        CHROME_BIN,
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-debugging-address=127.0.0.1",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
    ]
    
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "HOME": "/home/ghost"}
    )
    print(f"✓ Chrome launched (PID: {proc.pid}) on port {CHROME_PORT}")
    
    if wait_port(CHROME_PORT):
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{CHROME_PORT}/json/version", timeout=3)
            info = json.loads(resp.read())
            print(f"✓ Chrome WS endpoint: {info.get('webSocketDebuggerUrl', 'N/A')}")
            return proc
        except Exception as e:
            print(f"✗ Chrome port up but can't get WS: {e}")
            return proc
    else:
        print(f"✗ Chrome port {CHROME_PORT} didn't come up")
        proc.kill()
        return None

def launch_firefox():
    """Launch Firefox with remote debugging as ghost user."""
    if not os.path.isfile(FIREFOX_BIN):
        print(f"✗ Firefox not found: {FIREFOX_BIN}")
        return None
    
    cmd = [
        FIREFOX_BIN,
        f"--remote-debugging-port={FIREFOX_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless",
        "--profile", FIREFOX_PROFILE,
    ]
    
    # Run as ghost user to avoid XAUTHORITY issues
    proc = subprocess.Popen(
        ["sudo", "-u", "ghost"] + cmd,
        stdout=open("/tmp/firefox-debug.log", "w"),
        stderr=subprocess.STDOUT,
        env={**os.environ, "HOME": "/home/ghost", "USER": "ghost",
             "DISPLAY": os.environ.get("DISPLAY", ":0"),
             "XAUTHORITY": "/home/ghost/.Xauthority"}
    )
    print(f"✓ Firefox launched as ghost (PID: {proc.pid}) on port {FIREFOX_PORT}")
    
    if wait_port(FIREFOX_PORT):
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{FIREFOX_PORT}/json/list", timeout=3)
            tabs = json.loads(resp.read())
            for tab in tabs:
                print(f"  Tab: {tab.get('title', '?')} -> {tab.get('url', '?')[:80]}")
            return proc
        except Exception as e:
            print(f"✗ Firefox port up but can't get tabs: {e}")
            return proc
    else:
        print(f"✗ Firefox port {FIREFOX_PORT} didn't come up")
        print(f"  Check /tmp/firefox-debug.log")
        proc.kill()
        return None

def main():
    print("=== Browser Fix Tool ===")
    kill_stale()
    
    print("\n--- Launching Chrome ---")
    chrome_proc = launch_chrome()
    
    print("\n--- Launching Firefox ---")
    firefox_proc = launch_firefox()
    
    print("\n=== Summary ===")
    print(f"Chrome:  {'✓ Running' if chrome_proc else '✗ Failed'} (port {CHROME_PORT})")
    print(f"Firefox: {'✓ Running' if firefox_proc else '✗ Failed'} (port {FIREFOX_PORT})")
    
    if chrome_proc and firefox_proc:
        print("\n✓ Both browsers running with remote debugging!")
        print(f"  Chrome:  http://127.0.0.1:{CHROME_PORT}/json")
        print(f"  Firefox: http://127.0.0.1:{FIREFOX_PORT}/json")
    else:
        print("\n✗ Some browsers failed to start")
    
    return 0 if (chrome_proc and firefox_proc) else 1

if __name__ == "__main__":
    sys.exit(main())