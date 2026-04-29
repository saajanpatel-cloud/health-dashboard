# TestFlight checklist (HealthDashboard)

This app reads HealthKit on device and injects a daily CSV into the embedded web dashboard. You need an **Apple Developer Program** membership to distribute via TestFlight.

## Before you archive

1. Open `ios/HealthDashboard/HealthDashboard.xcodeproj` in Xcode.
2. Select the **HealthDashboard** target → **Signing & Capabilities**.
3. Set your **Team** (fills `DEVELOPMENT_TEAM`); change **Bundle Identifier** from `com.example.HealthDashboard` to a unique ID you own.
4. Confirm **HealthKit** is enabled (the target includes `HealthDashboard.entitlements` with `com.apple.developer.healthkit`).
5. **App icon**: add a `1024×1024` PNG under `Assets.xcassets` → **App Icon** (required for App Store Connect upload; placeholder-only catalogs are rejected for distribution).
6. **Privacy**: `Info.plist` already contains `NSHealthShareUsageDescription`. Adjust wording if Apple requests clearer scope.

## Archive and upload

1. **Product → Destination**: choose **Any iOS Device (arm64)** (not a simulator).
2. **Product → Archive**. When the Organizer opens, select the archive → **Distribute App** → **App Store Connect** → **Upload**.
3. Fix any signing or validation errors Xcode reports (missing icons, entitlements, etc.).

## App Store Connect

1. Create an **App** record with the same bundle ID and platform iOS.
2. After processing completes, open **TestFlight** for that app.
3. **Internal testing**: add your Apple ID under **Users and Access** → **Internal** (no Beta App Review).
4. **External testing** (optional): requires Beta App Review and a short privacy note.

## Health data questionnaire

App Store Connect asks whether the app uses **health or fitness data**. Answer **yes** and describe on-device aggregation for the dashboard (no server upload). If prompted for a **privacy policy URL**, host a short page stating data stays on device except what you explicitly export from the web UI.

## Device verification

On a physical iPhone: grant Health permissions, confirm the dashboard loads, tap **Refresh Data**, and confirm numbers are plausible versus the Mac export path for overlapping dates.
