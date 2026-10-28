# Build the apps

Copy these files into your project folder (next to google-auth.js, vault-routes.js, icons/, images/ etc.).
Merge package.json with yours (keep your own dependencies, add the scripts, devDependencies and "build" block).

## Windows installer (.exe + .msi)
    npm install
    npm run dist:win
Output: dist/, copied to downloads/ with sizes and sha256 in downloads/releases.json.
The MSI target needs WiX; electron-builder downloads it itself on Windows.

## macOS / Linux
Run `npm run dist:mac` on a Mac, `npm run dist:linux` on Linux (or WSL). releases.json keeps earlier platforms.

## Android APK
    cd mobile
    npm install
    npm run init
    npm run android
Copy the signed APK to mobile/out/ and run `npm run releases` in the project root. Needs Android Studio + JDK 17.
The app loads https://www.spacekhazana.com/app (edit mobile/capacitor.config.json to change).

## iOS
`npm run open:ios` in mobile/ (Mac + Xcode). Archive and upload to TestFlight. Until then the site shows the Add to Home Screen route.

## Run it
Desktop app: `npm run desktop` for a dev run. Data lives in the user profile folder, not the install folder.
Upload downloads/ to your server; the site fills the buttons from downloads/releases.json.
