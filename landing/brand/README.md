# CI Brand Assets

All assets are VT220 CRT: cyan phosphor (`#5fe6e8`) on deep navy (`#020a14`).

## Files in `brand/`

### Logo (SVG)
- `logomark.svg` — primary mark, animated blinking cursor
- `logomark-static.svg` — static variant (for favicons, OG, print)
- `wordmark-horizontal.svg` — mark + "CENTRAL INTELLIGENCE" horizontal lockup
- `wordmark-stacked.svg` — mark + two-line stacked wordmark

### Favicons (PNG)
| File | Size | Use |
|---|---|---|
| `favicon-16.png` | 16×16 | browser tab |
| `favicon-32.png` | 32×32 | browser tab / bookmarks |
| `favicon-48.png` | 48×48 | Windows taskbar |
| `favicon-180.png` | 180×180 | Apple touch icon |
| `favicon-192.png` | 192×192 | Android home |
| `favicon-512.png` | 512×512 | PWA / maskable |

### OG / social share images (PNG, 1200×630)
| File | Route |
|---|---|
| `og-home.png` | `/` |
| `og-agent.png` | `/agent` |
| `og-docs.png` | `/docs` |
| `og-dashboard.png` | `/dashboard` |

---

## Wiring into the site

### 1. Copy `brand/` into `public/`

```
public/
├── brand/
│   ├── logomark.svg
│   ├── logomark-static.svg
│   ├── favicon-16.png ... favicon-512.png
│   └── og-*.png
```

### 2. Add to `<head>` of every page

```html
<!-- Favicons -->
<link rel="icon" type="image/svg+xml" href="/brand/logomark-static.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon-180.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#020a14">
```

### 3. Per-page OG image

Replace the `og:image` URL in each page's existing OG meta block:

| Page | OG image |
|---|---|
| `/` | `https://<domain>/brand/og-home.png` |
| `/agent` | `https://<domain>/brand/og-agent.png` |
| `/docs` | `https://<domain>/brand/og-docs.png` |
| `/dashboard` | `https://<domain>/brand/og-dashboard.png` |

```html
<meta property="og:image" content="https://<domain>/brand/og-home.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://<domain>/brand/og-home.png">
```

### 4. `site.webmanifest`

```json
{
  "name": "Central Intelligence",
  "short_name": "CI",
  "icons": [
    { "src": "/brand/favicon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/brand/favicon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#020a14",
  "background_color": "#020a14",
  "display": "standalone"
}
```

---

## Color tokens

```css
--phosphor:    #5fe6e8;  /* primary cyan */
--phosphor-hi: #7ff4f6;  /* hover / highlight */
--void:        #020a14;  /* background */
--deep:        #031220;  /* card surface */
--line:        #0e3252;  /* dividers */
```

## Type

- Display: **VT323** (Google Fonts) — CRT bitmap, all caps headlines
- Body: **JetBrains Mono** — clean mono for text
- Fallbacks: `ui-monospace, Courier New, monospace`

## Usage rules

**DO** keep phosphor cyan on deep navy. Preserve chevron + cursor balance. Min mark size: 16×16 px. Clear space: 25% of mark height.

**DON'T** recolor, skew, or add drop shadows to the mark. Don't place on photographs without a navy plate. Don't combine the cursor block with other glyphs.
