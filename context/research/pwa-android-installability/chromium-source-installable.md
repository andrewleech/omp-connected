---
timestamp: 2026-09-24T20:08:30Z
research_topic: "PWA installability and Android (Chrome) best practice 2025-2026"
query: "current installability logic"
source_url: https://chromium.googlesource.com/chromium/src/+/main/components/webapps/browser/installable/installable_evaluator.cc
source_name: Chromium source: installable_evaluator.cc, app_banner_manager_android.cc, webapps_utils.cc, webapk_proto_builder.cc, webapk_single_icon_hasher.cc, constants.cc, installable_data_fetcher.cc
relevance: High
---

## Source
[Chromium source: installable_evaluator.cc, app_banner_manager_android.cc, webapps_utils.cc, webapk_proto_builder.cc, webapk_single_icon_hasher.cc, constants.cc, installable_data_fetcher.cc](https://chromium.googlesource.com/chromium/src/+/main/components/webapps/browser/installable/installable_evaluator.cc)

## Query Context
current installability logic

## Key Findings
- kMinimumPrimaryIconSizeInPx = 144; icon types PNG/SVG/WebP; purpose any.
- Display check evaluates display_override[0] if present; allowed standalone/fullscreen/minimal-ui/wco/tabbed/borderless.
- Secure: localhost, allowlisted, or valid SSL cert (security_state::IsSslCertificateValid).
- Android banner uses InstallableCriteria::kImplicitManifestFieldsHTML (name from title, icon from favicon, start_url implicit, display != browser) with non-empty manifest.
- WebAPK incompatible only if manifest URLs contain username/password.
- Chrome downloads icons itself and sends bytes (PNG/JPEG raw, others re-encoded PNG) to the WebAPK server in the request proto.
- Screenshots: min 320px, max 3840px, ratio <= 2.3, max 8, same aspect ratio; Android uses non-wide, desktop uses wide.
- WebAPK proto: MONOCHROME purpose 'not currently used'.
- Shell APK intent filter has scheme/host/path only, no port.

## Relevance Notes
Used for the PWA Android installability checklist.
