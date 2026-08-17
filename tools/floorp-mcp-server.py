#!/usr/bin/env python3
"""
floorp-mcp-server.py — MCP server for Floorp/Firefox browser automation.
Provides tools: navigate, click, type, screenshot, get_page_content, fill_form, google_oauth.
Connects to Firefox via remote debugging port using Playwright.
"""
import asyncio, os, sys, json, subprocess, time
from mcp.server.fastmcp import FastMCP

FIREFOX_PORT = 9223
FIREFOX_BIN = "/usr/bin/firefox"
FIREFOX_PROFILE = "/home/ghost/.mozilla/firefox/32de33i2.default-release"

mcp = FastMCP("floorp-browser")

_browser = None
_context = None
_page = None

async def get_browser():
    """Get or launch browser connection."""
    global _browser, _context, _page
    if _page and not _page.is_closed():
        return _page
    
    from playwright.async_api import async_playwright
    
    # Check if Firefox is already running with debug port
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sock.connect_ex(("127.0.0.1", FIREFOX_PORT)) != 0:
        # Launch Firefox
        subprocess.Popen(
            ["sudo", "-u", "ghost", FIREFOX_BIN,
             f"--remote-debugging-port={FIREFOX_PORT}",
             "--no-first-run", "--no-default-browser-check",
             "--headless", "--profile", FIREFOX_PROFILE],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/home/ghost", "USER": "ghost"}
        )
        # Wait for port
        for _ in range(15):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            if sock.connect_ex(("127.0.0.1", FIREFOX_PORT)) == 0:
                break
            await asyncio.sleep(1)
    
    pw = await async_playwright().start()
    _browser = await pw.firefox.connect_over_cdp(f"http://127.0.0.1:{FIREFOX_PORT}")
    _context = _browser.contexts[0] if _browser.contexts else await _browser.new_context()
    _page = await _context.new_page()
    return _page


@mcp.tool()
async def floorp_navigate(url: str) -> str:
    """Navigate Floorp/Firefox to a URL."""
    page = await get_browser()
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    return f"Navigated to: {page.url}\nTitle: {await page.title()}"


@mcp.tool()
async def floorp_click(selector: str) -> str:
    """Click an element by CSS selector or text."""
    page = await get_browser()
    try:
        await page.get_by_text(selector).click(timeout=5000)
        return f"Clicked: {selector}"
    except Exception:
        await page.click(selector, timeout=5000)
        return f"Clicked: {selector}"


@mcp.tool()
async def floorp_type(selector: str, text: str, submit: bool = False) -> str:
    """Type text into a field. Optionally submit."""
    page = await get_browser()
    await page.fill(selector, text)
    if submit:
        await page.press(selector, "Enter")
    return f"Typed '{text}' into {selector}"


@mcp.tool()
async def floorp_screenshot(path: str = "/tmp/floorp-screenshot.png") -> str:
    """Take a screenshot of the current page."""
    page = await get_browser()
    await page.screenshot(path=path, full_page=True)
    return f"Screenshot saved: {path}"


@mcp.tool()
async def floorp_get_content() -> str:
    """Get the current page text content and interactive elements."""
    page = await get_browser()
    title = await page.title()
    url = page.url
    content = await page.inner_text("body")
    # Truncate if too long
    if len(content) > 5000:
        content = content[:5000] + "\n... [truncated]"
    return f"Title: {title}\nURL: {url}\n\nContent:\n{content}"


@mcp.tool()
async def floorp_fill_form(fields: str) -> str:
    """Fill multiple form fields. fields is JSON: [{"selector": "#email", "value": "test@test.com"}, ...]"""
    page = await get_browser()
    field_list = json.loads(fields)
    results = []
    for field in field_list:
        await page.fill(field["selector"], field["value"])
        results.append(f"Filled {field['selector']}")
    return f"Filled {len(field_list)} fields: {', '.join(results)}"


@mcp.tool()
async def floorp_google_oauth(email: str, url: str) -> str:
    """Automate Google OAuth login flow on the current page."""
    page = await get_browser()
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(2)
    
    # Try "Continue with Google" button
    try:
        btn = page.get_by_role("button", name="Continue with Google")
        await btn.click(timeout=5000)
        await asyncio.sleep(3)
        result = "Clicked 'Continue with Google'"
    except Exception:
        # Try email input directly
        try:
            inp = page.get_by_role("textbox", name="Email")
            await inp.fill(email)
            await inp.press("Enter")
            await asyncio.sleep(2)
            result = f"Entered email: {email}"
        except Exception as e:
            result = f"Could not start OAuth: {e}"
    
    # Check if we need to select Google account
    try:
        account = page.get_by_text(email, exact=False)
        await account.click(timeout=3000)
        await asyncio.sleep(3)
        result += f"\nSelected account: {email}"
    except Exception:
        pass  # May already be logged in
    
    title = await page.title()
    return f"{result}\nCurrent URL: {page.url}\nTitle: {title}"


@mcp.tool()
async def floorp_get_snapshot() -> str:
    """Get accessibility snapshot of interactive elements on the page."""
    page = await get_browser()
    snapshot = await page.accessibility.snapshot()
    
    def extract_items(node, depth=0):
        items = []
        if not node:
            return items
        role = node.get("role", "")
        name = node.get("name", "")
        if role in ["button", "link", "textbox", "checkbox", "radio", "combobox", "tab"]:
            items.append(f"{'  '*depth}[{role}] {name}")
        for child in node.get("children", []):
            items.extend(extract_items(child, depth+1))
        return items
    
    items = extract_items(snapshot)
    return f"URL: {page.url}\nTitle: {await page.title()}\n\nInteractive elements:\n" + "\n".join(items[:50])


if __name__ == "__main__":
    mcp.run(transport="stdio")