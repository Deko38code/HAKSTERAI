#!/usr/bin/env python3
"""
Floorp/Firefox AI Automation Tool
Launches Firefox/Floorp with remote debugging and connects via Playwright.
Supports existing profiles with saved Google OAuth sessions.
"""

import subprocess
import time
import json
import os
import sys
import socket
import argparse
import urllib.request
from pathlib import Path

FIREFOX_BIN = os.environ.get("FIREFOX_BIN", "/usr/bin/firefox")
FLOORP_BIN = os.environ.get("FLOORP_BIN", "/usr/bin/floorp")
DEFAULT_PROFILE = os.environ.get("FLOORP_PROFILE", "/home/ghost/.mozilla/firefox")
DEBUG_PORT = int(os.environ.get("FLOORP_DEBUG_PORT", "9223"))


def find_browser():
    """Find Floorp or Firefox binary."""
    for path in [FLOORP_BIN, "/opt/floorp/floorp", "/usr/bin/floorp"]:
        if os.path.isfile(path):
            return path
    for path in [FIREFOX_BIN, "/usr/bin/firefox", "/snap/bin/firefox"]:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError("Neither Floorp nor Firefox found")


def find_profiles():
    """Find existing Firefox/Floorp profiles."""
    profiles = []
    for base in [DEFAULT_PROFILE, "/home/ghost/.floorp"]:
        if not os.path.isdir(base):
            continue
        for entry in os.listdir(base):
            full = os.path.join(base, entry)
            if os.path.isdir(full) and ".default" in entry.lower():
                profiles.append(full)
    return profiles


def is_port_free(port):
    """Check if a port is available."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def launch_browser(port=DEBUG_PORT, profile=None, headless=False, url=None):
    """Launch Firefox/Floorp with remote debugging enabled."""
    binary = find_browser()
    
    # Find profile if not specified
    if not profile:
        profiles = find_profiles()
        profile = profiles[0] if profiles else None
    
    cmd = [
        binary,
        f"--remote-debugging-port={port}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    
    if profile:
        cmd.extend(["--profile", profile])
    
    if headless:
        cmd.append("--headless")
    
    if url:
        cmd.append(url)
    
    print(f"Launching: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "MOZ_HEADLESS": "1" if headless else "0"}
    )
    
    # Wait for debugging port
    for i in range(30):
        if not is_port_free(port):
            print(f"Debug port {port} is active!")
            return proc
        time.sleep(1)
        print(f"Waiting for port {port}... ({i+1}/30)")
    
    print(f"ERROR: Port {port} didn't come up after 30s")
    proc.kill()
    return None


def get_debug_info(port=DEBUG_PORT):
    """Get browser debugging info."""
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/json/list", timeout=5)
        return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def connect_playwright(port=DEBUG_PORT, url=None):
    """Connect to running browser via Playwright."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Installing playwright...")
        subprocess.run([sys.executable, "-m", "pip", "install", "playwright"], check=True)
        from playwright.sync_api import sync_playwright
    
    with sync_playwright() as p:
        browser = p.firefox.connect_over_cdp(f"http://localhost:{port}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        
        if url:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            print(f"Navigated to: {page.url}")
            print(f"Title: {page.title()}")
        
        return browser, context, page


def google_oauth_flow(page, email="dekekenneth840@gmail.com"):
    """Automate Google OAuth login flow."""
    print(f"Starting Google OAuth for {email}")
    
    # Wait for page to load
    time.sleep(2)
    
    # Look for "Continue with Google" button
    try:
        google_btn = page.get_by_role("button", name="Continue with Google")
        google_btn.click()
        print("Clicked 'Continue with Google'")
        time.sleep(3)
    except Exception as e:
        print(f"Could not click Google button: {e}")
        # Try entering email directly
        try:
            email_input = page.get_by_role("textbox", name="Email")
            email_input.fill(email)
            email_input.press("Enter")
            print(f"Entered email: {email}")
            time.sleep(2)
        except Exception as e2:
            print(f"Could not enter email: {e2}")
    
    # Check if we need to select Google account
    try:
        account = page.get_by_text(email, exact=False)
        account.click()
        print(f"Selected Google account: {email}")
        time.sleep(3)
    except:
        pass  # May already be logged in
    
    # Check current state
    print(f"Current URL: {page.url}")
    print(f"Title: {page.title()}")
    
    return page


def main():
    parser = argparse.ArgumentParser(description="Floorp/Firefox AI Automation")
    parser.add_argument("action", choices=["launch", "connect", "debug", "oauth"], help="Action to perform")
    parser.add_argument("--port", type=int, default=DEBUG_PORT, help="Debug port")
    parser.add_argument("--profile", type=str, help="Browser profile path")
    parser.add_argument("--headless", action="store_true", help="Headless mode")
    parser.add_argument("--url", type=str, help="URL to navigate to")
    parser.add_argument("--email", type=str, default="dekekenneth840@gmail.com", help="Google email for OAuth")
    
    args = parser.parse_args()
    
    if args.action == "launch":
        proc = launch_browser(args.port, args.profile, args.headless, args.url)
        if proc:
            print(f"Browser launched (PID: {proc.pid})")
            info = get_debug_info(args.port)
            print(f"Debug info: {json.dumps(info, indent=2)[:500]}")
    
    elif args.action == "connect":
        browser, context, page = connect_playwright(args.port, args.url)
        print(f"Connected! URL: {page.url}")
        # Keep alive
        input("Press Enter to close...")
        browser.close()
    
    elif args.action == "debug":
        info = get_debug_info(args.port)
        print(json.dumps(info, indent=2))
    
    elif args.action == "oauth":
        browser, context, page = connect_playwright(args.port, args.url)
        page = google_oauth_flow(page, args.email)
        input("Press Enter to close...")
        browser.close()


if __name__ == "__main__":
    main()