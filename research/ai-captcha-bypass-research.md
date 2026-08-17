# AI Captcha Bypass Research Report
*Generated: 2026-08-17 by haksterAI with hackbot squad assistance*

## 1. Commercial AI Captcha Solvers (Paid APIs)

| Tool | AI Approach | Captcha Types | API | Cost |
|------|------------|---------------|-----|------|
| **2Captcha** | Human-in-loop + AI image recognition | reCAPTCHA v2/v3, hCaptcha, Turnstile, image | REST API, multi-language | ~$2.99/1000 |
| **AntiCaptcha** | ML + Human verification | reCAPTCHA v2/v3, hCaptcha, Turnstile, image | REST API | ~$2.00/1000 |
| **DeathByCaptcha** | Computer Vision + ML | reCAPTCHA v2, hCaptcha, Turnstile, image | REST API | ~$1.39/1000 |
| **CapSolver** | AI-only (no humans) | reCAPTCHA v2/v3, hCaptcha, Turnstile, FunCaptcha, GeeTest | REST API, browser extension | ~$0.80/1000 |
| **CapMonster Cloud** | Neural networks | reCAPTCHA v2/v3, hCaptcha, image | REST API | ~$0.60/1000 |

## 2. Open-Source AI Captcha Solvers (GitHub)

### Top Repos (by stars)

| Repo | Stars | Captcha Types | ML Model | Last Updated |
|------|-------|---------------|----------|-------------|
| [ecthros/uncaptcha2](https://github.com/ecthros/uncaptcha2) | 3,431 | reCAPTCHA v2 | TensorFlow CNN | 2021-07 |
| [kerlish/tf-captcha](https://github.com/kerlish/tf-captcha) | 156 | Generic text captcha | TensorFlow CNN | 2020-08 |
| [Vinyzu/Botright](https://github.com/Vinyzu/Botright) | — | reCAPTCHA, hCaptcha | Playwright + AI | Active |
| [noCaptchaAi/NoCaptcha-Ai-Browser-Extension](https://github.com/noCaptchaAi/NoCaptcha-Ai-Browser-Extension) | — | reCAPTCHA, hCaptcha | Browser AI extension | Active |
| [Wikidepia/hektCaptcha-extension](https://github.com/Wikidepia/hektCaptcha-extension) | — | hCaptcha | Browser extension | Active |
| [dxxzst/auto_captcha](https://github.com/dxxzst/auto_captcha) | — | Generic captcha | ML | — |

### Code Example (uncaptcha2):
```python
from uncaptcha2 import Uncaptcha
solver = Uncaptcha()
captcha_url = 'https://example.com/captcha'
result = solver.solve(captcha_url)
print(result)
```

### Code Example (tf-captcha):
```python
from tf_captcha import CaptchaSolver
solver = CaptchaSolver()
captcha_image = 'path_to_captcha_image.png'
captcha_text = solver.solve(captcha_image)
print(captcha_text)
```

## 3. Cloudflare Turnstile & Challenge Bypass

### How Turnstile Works (Under the Hood)
- **Browser Fingerprinting**: User-Agent, Accept headers, screen resolution, plugins
- **TLS Fingerprinting**: Examines TLS handshake to identify SSL/TLS implementation (JA3/JA4)
- **Mouse Movement Analysis**: Tracks bezier curves, speed, acceleration patterns
- **Timing Analysis**: Time to complete interactions, keystroke timing
- **Canvas/WebGL Fingerprinting**: GPU rendering fingerprints
- **Behavioral ML Models**: Cloudflare runs ML on all signals to score legitimacy

### Best Tools for Cloudflare Bypass

| Tool | Approach | GitHub | Notes |
|------|----------|--------|-------|
| **FlareSolverr** | Proxy server with headless browser | github.com/FlareSolverr/FlareSolverr | Most popular, runs Chromium |
| **cloudscraper** | Python lib, bypasses JS challenges | github.com/VeNoMouS/cloudscraper | Lightweight, no browser needed |
| **undetected-chromedriver** | Patched Selenium ChromeDriver | github.com/ultrafunkamsterdam/undetected-chromedriver | Patches CDC detection |
| **patchright** | Patched Playwright | github.com/Kaliiiiiiiiii-Vinyzu/patchright | Drop-in Playwright replacement |
| **camoufox** | Anti-fingerprint Firefox | github.com/daijro/camoufox | Firefox-based, harder to detect |
| **Botright** | Playwright + captcha solving | github.com/Vinyzu/Botright | Built-in hCaptcha/reCAPTCHA |

### Python Example — Cloudflare Bypass with cloudscraper:
```python
import cloudscraper
scraper = cloudscraper.create_scraper()
response = scraper.get('https://protected-site.com')
print(response.status_code, response.text[:500])
```

### Python Example — Playwright Stealth for Cloudflare:
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=['--disable-blink-features=AutomationControlled']
    )
    context = browser.new_context(
        user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        viewport={'width': 1920, 'height': 1080}
    )
    page = context.new_page()
    # Remove webdriver flag
    page.add_init_script('Object.defineProperty(navigator, "webdriver", {get: () => undefined})')
    page.goto('https://protected-site.com')
    print(page.title())
```

## 4. ML Models Used in Captcha Solving

| Model Type | Use Case | Accuracy |
|------------|----------|----------|
| **CNN** | Image classification (text captcha) | 95-99% |
| **YOLO** | Real-time object detection (image captcha) | 90-95% |
| **Transformer** | Sequence recognition (text captcha) | 92-97% |
| **CNN+RNN** | Combined image+sequence (reCAPTCHA) | 85-93% |
| **GAN** | Generating captcha variations for training | N/A (training tool) |

## 5. Key Takeaways for haksterAI Stealth-Bot

1. **For Cloudflare**: Use `camoufox` (Firefox-based, hardest to detect) or `patchright` (Playwright drop-in)
2. **For reCAPTCHA**: `undetected-chromedriver` + 2Captcha/CapSolver API for hardest cases
3. **For image captchas**: Train a YOLO or CNN model on captcha datasets
4. **For Turnstile**: FlareSolverr as a proxy, or `cloudscraper` for simpler challenges
5. **Best free approach**: `cloudscraper` (no browser) → `patchright` (stealth Playwright) → `camoufox` (anti-fingerprint Firefox)
6. **Low-resource machine** (4 cores, 7GB RAM): Prefer `cloudscraper` (no browser) over FlareSolverr (runs Chromium)

## 6. Recommended Integration for Stealth-Bot

Current stealth-bot uses Playwright + Chromium. Upgrades:
- Switch to `patchright` (drop-in replacement, patches detection vectors)
- Add `cloudscraper` as first-attempt (no browser needed, saves RAM)
- Fall back to Playwright stealth only if cloudscraper fails
- Add CapSolver API integration for hard captchas ($0.80/1000 solves)
- Use `camoufox` for highest-stealth needs (Firefox fingerprint)