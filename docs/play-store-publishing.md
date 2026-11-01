# Google Play Store Publishing Process & Costs

Companion to [app-store-publishing.md](app-store-publishing.md), covering the Android equivalent for the same app (see [ios-app-plan.md](ios-app-plan.md) for architecture — the same options apply: WebView wrapper, native Kotlin/Compose, or Capacitor hybrid targeting Android).

## 1. Cost summary (Play Store only)

| Item | Cost | Notes |
|---|---|---|
| Google Play Developer account | **$25 one-time** | Paid once, ever — no annual renewal (unlike Apple's $99/year). |
| Play Store transaction fee (commission) | **0% for this app** | Google's 15–30% cut (Play Billing) only applies to in-app purchases/subscriptions sold through Google Play. Since all payments happen on the web app, no commission applies. |
| Google Play "small app" reduced rate (15%) | N/A | Only relevant if Play Billing is added later for revenue under $1M/year. Not applicable now. |
| Code signing | Free | Google Play App Signing (Google manages your app signing key) is free and recommended. |
| Internal/closed/open testing tracks | Free | Google Play's equivalent of TestFlight, included with the developer account. |
| Android device/emulator to build & test | Varies (one-time, if not already owned) | Android Studio + emulator works without physical hardware, but real-device testing is recommended. |
| App icon / screenshot design | Depends on design resourcing | Same Claude Design assets as iOS, resized per Play Store specs. |

**Bottom line: $25 one-time, no recurring fee, no commission** — cheaper than the App Store both up front and long-term, since there's no annual renewal.

## 2. Why no Google commission applies here

Google Play's 15–30% fee (Play Billing policy) applies specifically to **digital goods/services purchased inside the app**. Since:
- All payments/subscriptions happen on the **web app** (`checkout/*`), and
- The Android app doesn't sell digital content or subscriptions via Google Play Billing,

...no commission applies. Google Play's policy here is historically more permissive than Apple's: linking out to an external website for payment (a "Payments" link outside the app) has generally been allowed on Android without the same restrictions Apple imposed pre-2024, but it's still worth confirming current Google Play Billing policy (section on "alternative billing") before submission since policy has evolved.

## 3. Submission process, step by step

### Step 1 — Google Play Developer account (do this early)
1. Enroll at [play.google.com/console/signup](https://play.google.com/console/signup) — **$25 one-time fee**.
2. Choose account type:
   - **Individual (Personal)**: listed under your name.
   - **Organization**: listed under company name — requires a D-U-N-S number (same as Apple) for verification in most regions. Recommended for a real product, same reasoning as iOS.
3. Identity verification: Google requires ID verification and (for organizations) business document verification — can take a few days, similar to Apple's Organization flow. Start this in parallel with the iOS Developer Program enrollment since both can run concurrently.

### Step 2 — App identity setup
1. Create the app in Google Play Console (app name, default language, app/game type, free/paid).
2. Set the package name (e.g. `com.samdoctor.app` — should match/mirror the iOS bundle ID for consistency, though they're independent namespaces).
3. Set up Firebase Cloud Messaging (FCM) if using push notifications (Android's equivalent of APNs) — free, tied to a Firebase project.

### Step 3 — Build
1. Build in Android Studio (native Kotlin/Compose, or Capacitor/hybrid per chosen architecture).
2. Generate a signed **Android App Bundle (.aab)** — Google Play requires AAB format (not APK) for new apps.
3. Use **Google Play App Signing**: Google holds the final signing key, you keep an upload key. Simpler and safer than iOS's local certificate management.

### Step 4 — Testing tracks (Play Console's TestFlight equivalent)
Google Play has more granular pre-release tracks than TestFlight:
- **Internal testing**: up to 100 testers, near-instant availability, no review.
- **Closed testing**: larger invite-only group, lightweight review.
- **Open testing**: public beta, anyone with the link can join, still pre-review.
- All are free and don't require the account to be verified yet, though final production release does.

Use this phase to validate FCM push, deep links (App Links), and that no payment surface is exposed, same as the iOS TestFlight phase.

**Important Play-specific requirement**: since late 2023, Google requires new developer accounts to test with at least 20 testers for 14 days in a closed track before being allowed to publish to production. Factor this ~2-week minimum into the timeline — it doesn't exist on the Apple side.

### Step 5 — App Store listing metadata
Prepare in Play Console:
- App name, short description (80 chars), full description (4000 chars), category
- Screenshots (phone required; tablet/Chromebook optional) — reuse iOS screenshot art resized to Android aspect ratios
- App icon (512×512) and feature graphic (1024×500, Android-specific, shown on Play Store listing pages)
- Privacy policy URL (required)
- Data safety form (Android's equivalent of Apple's "nutrition label" — must accurately disclose data collection/sharing)
- Content rating questionnaire (via IARC, Google's rating body — different process than Apple's age rating)
- Target audience declaration
- Ads declaration (does the app contain ads — likely "No" here)

### Step 6 — Submit for review
1. Roll out to production track once internal/closed testing requirements are satisfied.
2. **Google Play review timeline**: typically a few hours to a few days for a first-time app; can be longer (up to 7 days) for new developer accounts or apps requesting sensitive permissions.
3. Common rejection/flag risks for this app specifically:
   - **Data safety form mismatches**: Google actively checks that declared data collection matches actual app behavior (via automated scanning) — mismatches are a common rejection reason.
   - **Minimum functionality / "webview app" policy**: similar to Apple's 4.2, Google restricts apps that are just a repackaged website with no added value — same mitigation as iOS (native navigation, push, real native features).
   - **Permissions**: requesting permissions (camera, location, etc.) not clearly justified in the listing can trigger review flags.
   - **Login-gated content**: provide reviewer test credentials in the App Content section if login is required to see functionality.
4. If rejected, fix and resubmit — no additional cost; turnaround for re-review is usually faster than first submission.

### Step 7 — Release
- Staged rollout supported (release to a % of users, e.g. 10% → 50% → 100%) to catch crashes early — same concept as Apple's phased release.
- Can halt a staged rollout instantly if issues are found, before it reaches 100%.

## 4. Ongoing costs / maintenance

- **$0 recurring** — the $25 fee is paid once, ever (unlike Apple's $99/year).
- Android target API level requirements: Google requires apps to target a recent Android API level, enforced roughly annually (similar cadence to Apple's SDK requirement) — this is a dev/maintenance cost, not a cash cost.
- No Google revenue share since there's no Play Billing usage.

## 5. Summary

| Phase | Time estimate | Cost |
|---|---|---|
| Developer account verification | 1–5 business days (Org account) | $25 one-time |
| Closed testing (Google's minimum: 20 testers / 14 days for new accounts) | ~2 weeks minimum | Free |
| Google Play review (first submission) | Hours to ~7 days | Free |
| **Total new Play Store cost** | — | **$25 one-time, no recurring fee, no commission** |

## 6. iOS vs Android at a glance

| | App Store (iOS) | Play Store (Android) |
|---|---|---|
| Account fee | $99/year | $25 one-time |
| Commission (no IAP used) | 0% | 0% |
| Build format | .ipa via Xcode | .aab via Android Studio |
| Signing | Local cert/profile (or automatic via Xcode) | Google Play App Signing (Google-managed) |
| Pre-release testing | TestFlight | Internal/Closed/Open testing tracks |
| Mandatory testing period | None | 20 testers / 14 days (new accounts, closed track) |
| Review time (first submission) | ~24–48 hrs typical | Hours–7 days typical |
| Push notifications | APNs | Firebase Cloud Messaging (FCM) |
