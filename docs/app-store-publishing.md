# App Store Publishing Process & Costs

Quick reference for what it takes to get the iPhone app (see [ios-app-plan.md](ios-app-plan.md)) live on the App Store.

## 1. Cost summary (App Store only)

| Item | Cost | Notes |
|---|---|---|
| Apple Developer Program membership | **$99/year** | Required to submit any app. Individual or Organization account. Enrolling as an Organization additionally requires a D-U-N-S number (free, but can take 1–5 business days to obtain if you don't already have one). |
| App Store transaction fee (commission) | **0% for this app** | Apple only takes a cut (15–30%) on **in-app purchases / subscriptions sold through Apple's IAP**. Since payments happen only on the web app, not in the iOS app, there is no Apple commission to pay. |
| Apple Developer "Small Business Program" (15% rate) | N/A | Only relevant if IAP is ever added later and revenue is under $1M/year. Not applicable now since no IAP is planned. |
| Code signing certificates | Free | Included with the $99/year membership. |
| TestFlight (beta testing) | Free | Included with membership, up to 10,000 external testers. |
| Mac hardware (to build/submit) | Varies (one-time, if not already owned) | Xcode + App Store Connect submission requires a Mac. |
| App icon / screenshot design | Depends on design resourcing | Being handled in Claude Design per your note. |

**Bottom line: ~$99/year total**, since there are no in-app purchases. That's the only recurring App Store cost for a payments-free companion app.

## 2. Why no Apple commission applies here

Apple's 15–30% cut applies specifically to **digital goods/services purchased inside the app** via Apple's In-App Purchase API (App Store Review Guideline 3.1.1). Since:
- All payments/subscriptions happen on the **web app** (`checkout/*`), and
- The iOS app does not sell digital content, subscriptions, or unlock features via payment inside the app,

...Apple's commission does not apply. This is the same model used by apps like Netflix or Spotify's "reader" apps that don't offer in-app purchase for content consumed via a web-purchased subscription — as long as the app doesn't provide a way to purchase inside it.

**Important caveat**: the app must not link out to a payment flow *for digital content* in a way that violates guideline 3.1.1 (previously "external purchase link" restrictions were strict; Apple has relaxed this somewhat in the US following legal rulings, but the safest, review-proof approach is: the app simply doesn't mention purchasing/subscribing at all, and any account/billing management is done by the user separately on the web, not via a button/link in the app that triggers a purchase flow). Recommend explicit design review of any "manage subscription" or "upgrade" UI in the app against current App Store Review Guidelines before submission — these rules do shift over time.

## 3. Submission process, step by step

### Step 1 — Apple Developer account (do this early, not blocking on design)
1. Enroll at [developer.apple.com/programs](https://developer.apple.com/programs) — $99/year.
2. Decide Individual vs Organization account:
   - **Individual**: app is listed under your personal name. Faster to set up.
   - **Organization**: app listed under company name (recommended for a real product). Requires D-U-N-S number + legal entity verification — start this first, it's the slowest step (can take days).
3. Once approved, set up **App Store Connect** access (appstoreconnect.apple.com) — this is where builds, metadata, and releases are managed.

### Step 2 — App identity setup
1. Register a Bundle ID (e.g. `com.samdoctor.app`) in the Developer portal.
2. Create the App Store Connect app record (name, primary language, bundle ID, SKU).
3. Set up push notification capability (APNs key) if using notifications (see ios-app-plan.md).

### Step 3 — Build
1. Build the app in Xcode (native, Capacitor, or wrapper — per chosen architecture).
2. Configure signing (automatic signing via Xcode is simplest for a small team).
3. Archive the build and upload to App Store Connect via Xcode or Transporter.

### Step 4 — TestFlight (beta testing, recommended before public release)
1. Uploaded builds automatically become available for internal TestFlight testing (up to 100 internal testers, no review needed).
2. For external testers (up to 10,000), Apple does a lightweight "Beta App Review" (usually faster/less strict than full review) — typically 24–48 hours.
3. Use this phase to validate push notifications, deep links, and the "no payment in app" flows work as intended.

### Step 5 — App Store listing metadata
Prepare in App Store Connect:
- App name, subtitle, description, keywords
- Screenshots (per device size — at minimum 6.7" iPhone; Apple auto-scales or you provide per-size)
- App icon (1024×1024, from Claude Design output)
- Privacy policy URL (required)
- App Privacy details (data collection disclosure — "nutrition label") — needs to accurately reflect what data the app collects (auth, usage, etc.)
- Age rating questionnaire
- Category (e.g. Business / Productivity)
- Support URL

### Step 6 — Submit for review
1. Attach a build to the version, fill "What's New," submit for review.
2. **Apple App Review timeline**: typically 24–48 hours for a first decision (can vary; complex apps or first-time submissions sometimes take longer).
3. Common rejection risks for this app specifically:
   - **Guideline 4.2 (Minimum Functionality)**: if the app is seen as "just a website," a plain WebView wrapper with no native value can be rejected. Mitigate via native navigation, push notifications, and real native features (see ios-app-plan.md Option B/C recommendation).
   - **Guideline 5.1.1 (Data collection/privacy)**: privacy policy and App Privacy labels must be accurate and present.
   - **Login-gated content**: Apple may ask for a demo/test account in review notes if the app requires login to see anything — prepare a reviewer test account.
4. If rejected, address feedback and resubmit — no additional cost, just time (each resubmission goes through review again, another ~24–48 hrs).

### Step 7 — Release
- Choose manual release or automatic release on approval.
- Can do a phased rollout (7-day gradual rollout to % of users) to catch issues early.

## 4. Ongoing costs / maintenance

- **$99/year** renewal for the Developer Program — required annually or the app is pulled from the Store.
- Xcode/iOS SDK updates — periodically need to rebuild against new iOS SDK versions (Apple requires apps to target a recent SDK, enforced roughly annually).
- No Apple revenue share since there's no IAP.

## 5. Summary

| Phase | Time estimate | Cost |
|---|---|---|
| Developer account approval (Org account) | 1–5 business days | $99/year |
| Build + TestFlight beta | Depends on dev/design timeline | Free |
| App Store review (first submission) | 24–48 hrs typical | Free |
| **Total new App Store cost** | — | **$99/year, no commission** |
