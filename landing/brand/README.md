# CI Brand Assets — v2 palette

Updated palette based on the VT220 reference photo: **cooler, desaturated cyan-white** phosphor instead of saturated teal.

## Color tokens

```css
--phosphor:     #b8eef0;  /* main — cyan-white, slightly desaturated */
--phosphor-hi:  #dff6f7;  /* highlights */
--phosphor-dim: #7bbec0;  /* dim labels */
--void:         #050d18;  /* background — warm-cool near-black */
--deep:         #081523;  /* card surface */
--line:         #123049;  /* dividers */
```

## Files in `brand/`

### Logo (SVG)
- `logomark.svg` — animated blinking cursor
- `logomark-static.svg` — static
- `wordmark-horizontal.svg`, `wordmark-stacked.svg`

### Favicons (PNG): `favicon-{16,32,48,180,192,512}.png`

### Square logos (PNG): `logo-square-{256,512,1024}.png`

### OG images (1200×630): `og-{home,agent,docs,dashboard}.png`

### LinkedIn banner: `linkedin-banner-1128x191.png`

## Wiring

Drop `brand/` into `public/` and add to each page's `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/brand/logomark-static.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon-180.png">
<meta name="theme-color" content="#050d18">
<meta property="og:image" content="https://<domain>/brand/og-home.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
```

Per-page OG: swap `og-home.png` for `og-agent.png` / `og-docs.png` / `og-dashboard.png`.
