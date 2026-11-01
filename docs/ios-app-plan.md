# iPhone App Plan

Quick reference for turning this SvelteKit web app into an iPhone app. Design is being worked on separately in Claude (Figma/Claude Design) — this doc covers architecture, scope, and how it fits with the existing web app.

## 1. Scope: what the app is for

The mobile app is **not a replacement for the web app**. It's a companion app used as part of **extended services** — i.e. a subset of the product experience, not the full feature set.

- **No payments in the app.** All checkout, subscriptions, and billing-portal actions stay on the web app (`/checkout/*`, `/api/checkout/*`, Stripe billing portal). The app must never embed a card-entry flow or call payment endpoints directly.
- If a mobile user needs to pay/subscribe/upgrade, the app hands off to the web app (in-app browser / Safari) rather than building native payment UI. This also avoids Apple's In-App Purchase (IAP) requirement — see the cost note below.
- Likely "extended services" scope (adjust to what's actually planned): notifications, chat/assistance, store status, issue tracking, quick reference/lookup — the read-mostly / engagement features already visible in `src/routes/(app)/`.

## 2. Architecture options

### Option A — Native wrapper (WKWebView) around the existing web app
- A thin native Swift/SwiftUI shell that loads the deployed web app in a `WKWebView`, plus native chrome for push notifications, deep links, and app-store presence.
- Fastest path to a store listing. Reuses 100% of existing SvelteKit UI/logic.
- Native additions: push notification registration (APNs), a native tab bar/nav if needed, biometric unlock optionally.
- Payments risk: if the web content inside the WebView lets users pay for **digital** content/subscriptions from within the app, Apple can require IAP. Mitigation: mobile build only exposes non-payment routes, or explicitly routes payment/subscription actions out to a browser via `SFSafariViewController` (not embedded), which Apple treats differently. Confirm with Apple's guideline 3.1.1 before submission.

### Option B — Native app (SwiftUI) hitting existing APIs
- Real native UI, calling your existing SvelteKit `+server.ts` API routes (`src/routes/api/**`) as a backend.
- Better UX, offline handling, push notifications, native feel — more build effort, and no native payment surface at all (server just doesn't expose payment actions to mobile clients).
- Recommended if the "extended services" scope is small and stable (chat/assistance, notifications, issue status) — a small set of native screens is manageable.

### Option C — Capacitor/Ionic hybrid wrapping the Svelte app
- Wraps the existing Svelte codebase (or a mobile-specific subset of routes) using Capacitor, giving native APIs (push, biometrics) with much less native code than Option B.
- Middle ground between A and B. Good option if the design team wants pixel parity with the web design system while still shipping something closer to "native" (native nav transitions, App Store review treats it as a regular app, not a "website wrapper" which Apple sometimes rejects under 4.2 "Minimum Functionality").

**Recommendation for a payments-free, extended-services companion app:** Option C (Capacitor) or Option B (small native app). Avoid a pure WebView wrapper (Option A) unless the app adds real native functionality (push, notifications) — Apple frequently rejects apps that are just a website in a WebView with no native value (guideline 4.2).

## 3. What "extended services" implies for scope-cutting

Existing web app features that should likely **stay web-only** (based on current routes):
- Checkout / payment / billing portal (`/checkout/*`, `/api/checkout/*`, `/api/stripe/*`) — payments excluded from app per requirement.
- Full admin / Salesforce sync tooling (`src/lib/server/salesforce/*`, `/api/admin/*`) — internal/admin, not end-user mobile scope.
- Complex data entry flows (subscriptions management, contracts) — better suited to desktop/web.

Good candidates to bring to mobile (from current routes):
- `stores/[id]` overview, `stores/[id]/issues`, `stores/[id]/chat` — status/communication, well suited to push notifications.
- `feedback` (`src/routes/(app)/feedback/`) — lightweight, native-friendly.
- Notifications (`NotificationBell.svelte`, `/api/notifications/`) — natural fit for APNs push.
- Dashboard summary view.

## 4. Native-specific additions needed regardless of approach

- **Push notifications**: APNs certificate/key setup in Apple Developer account, a notification service (could reuse existing `/api/notifications/` backend logic, adapted to send APNs payloads instead of/alongside web push).
- **Deep linking**: Universal Links (associated domains) so notification taps and shared links open the right screen in-app.
- **App icons & launch screen**: once Claude Design finishes the design, export icon set (1024×1024 master + generated sizes) and launch screen assets.
- **Auth**: reuse existing session/auth mechanism; if it's cookie-based, a WebView/Capacitor approach reuses it directly, a pure-native app needs a token-based auth bridge.

## 5. Suggested next steps

1. Wait for Claude Design output to confirm final navigation structure and which routes are in scope for "extended services."
2. Decide Option B vs C based on how much native polish (animations, offline, native nav) is wanted vs. dev time.
3. Stand up Apple Developer account access (see [App Store publishing](app-store-publishing.md)) early — account approval and certificates can take a few days and shouldn't block on design.
4. Build a minimal TestFlight build early (even just notifications + one screen) to validate push/deep-link plumbing before full UI is ready.

See [app-store-publishing.md](app-store-publishing.md) for the submission process and costs.
