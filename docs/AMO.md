# Mozilla Add-ons (AMO) publication checklist

1. Run `python3 -m unittest discover -s tests -v` and `npm run lint` (see package.json).
2. Run `npm run build` to produce a reproducible unsigned `dist/hls-grabber-unsigned.xpi`.
3. Submit the **unlisted** build first to test signing, then create a **listed** submission when the reviewer materials are ready. Mozilla decides whether to approve/sign.
4. Set a support email/contact in AMO, upload screenshots, choose a license and a listing description. Link to the repository and `PRIVACY.md` from the listing.
5. In reviewer notes explain that capture is opt-in per tab and all-site permission is requested because HLS content can be hosted on arbitrary CDN domains, including cross-origin iframe resources.
6. Explain the optional data collection permissions: `authenticationInfo` (site cookies/Bearer tokens), `browsingActivity` (HLS URLs), `websiteContent` (media/preview contents); no project-operated telemetry server.
7. Supply a documented reproducible test setup or staging server with short-lived test credentials. **Never submit real site tokens, cookies or private API secrets publicly.**
8. Firefox desktop 140+ is supported; this is a Manifest V2 extension. Review browser compatibility and AMO policy updates before release.
9. AMO signs a submitted XPI. The `dist/` file from `npm run build` is unsigned and cannot normally be permanently installed on release Firefox.

## Permissions rationale for reviewers

- `webRequest`: observes network request headers for `.m3u8` only in explicitly enabled tabs.
- `<all_urls>` **optional**: CDNs and iframe media requests may use unrelated origins; requested only when activating capture.
- `tabs`: identifies the active page, tab changes and tab removal.
- `nativeMessaging`: optional installation of the local Linux downloader; invoked only for local jobs.
- `clipboardWrite`: copies a command when the user explicitly clicks Copy.
- `storage`: backend URL/token and mode settings; captured streams remain session-only.

The backend code, local helper and build scripts are available in this repository.
The backend is user-hosted, not a service operated by the extension authors.

Relevant documentation:
- https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
- https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
