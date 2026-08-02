# Internship Pilot Chrome extension

The loadable unpacked extension is:

`C:\Users\Molhm\Desktop\Internship-AI\extension\dist`

It uses Manifest V3, fills from the local authenticated Internship Pilot API,
and never clicks Submit.

## Install in normal Chrome

1. Start Internship Pilot from the project folder with `npm run dev`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** in the upper-right corner.
4. Select **Load unpacked**.
5. Choose `C:\Users\Molhm\Desktop\Internship-AI\extension\dist`.
6. In a terminal in the project folder, run `npm run extension:token`.
7. Open the Internship Pilot extension popup, paste that token, leave the app
   address as `http://localhost:3000`, and select **Connect securely**.
8. Start an application from Internship Pilot. On the application page, press
   the injected **Autofill with Internship Pilot** button.
9. Review every answer and upload. Press Submit manually only when you are
   satisfied.

After changing files in `extension/dist`, run `npm run extension:build` (it
validates the package and checks the server/extension protocol versions
match), select the extension's refresh icon on `chrome://extensions`, then
refresh the application page.

## Version handshake

The popup shows the extension version and the running server's build and
protocol version. If they are incompatible it says "Version mismatch — do not
autofill" and the in-page button refuses to run a fill until you rebuild the
extension (`npm run extension:build`) and reload it, or restart the app. This
prevents a new extension from silently running against a stale server.

## Worker-driven autofill

When you press "Apply with Application Agent" in the dashboard, the background
application worker launches its own Chromium with this same extension loaded
(unpacked from `extension/dist`) and seeds the local token automatically, so
it fills forms exactly the way the button does in your normal Chrome. The
worker never clicks Submit.
