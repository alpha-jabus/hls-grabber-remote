# HLS Grabber privacy notice / Политика конфиденциальности

Last updated: 2026-10-17

HLS Grabber is an open-source Firefox extension. The maintainers do not operate
a central collection server and do not receive browsing history, cookies,
credentials or downloaded video from the extension.

## Data handled in Firefox

The extension only records HLS (`.m3u8`) requests in a tab after the user presses
**Enable capture on this tab**. Firefox will ask for website access; CDN media
may come from a different domain than the visible website. Captured playlist URLs,
request headers (potentially `Cookie`, `Authorization` and custom tokens), request
time and tab association remain in Firefox's in-memory extension process.
They are cleared when the tab is closed, capture is disabled, a different site
is visited or the browser closes; stale records are discarded after two hours.

## Data leaving Firefox

Nothing is automatically uploaded to the project's maintainers. If the user
configures their own backend and explicitly enables remote mode, or chooses
local downloading through the native helper, Firefox requests the optional data
collection permissions `authenticationInfo`, `browsingActivity` and
`websiteContent`. The user may revoke them in Firefox's Add-ons settings.

In remote mode, when a popup requests a preview, starts a download, or lists jobs,
the extension sends a configured server API Bearer token to the user's specified
server. Preview and download requests additionally send the selected playlist
URL and relevant HTTP headers. Preview requests can happen automatically **only
when the user opens the popup**, after both remote mode and the Firefox data
consent have been enabled. GIFs and downloads are explicit actions. In local
mode, the selected URL and headers go to the locally installed Python native
messaging helper only when the user clicks Download.

The backend retrieves video over the network; the source/CDN sees requests from
the backend's IP, with the forwarded headers. No project-controlled analytics or
telemetry are used. Other network infrastructure and the chosen hosting provider
may have their own logs and privacy practices.

## Retention and controls

The configured backend URL and secret API token are stored in Firefox
`storage.local`, **not in encrypted storage**. The backend stores downloaded
videos and job metadata (name, path, status, timing), but not URLs or site
cookies as job records. The Python processes hold request data in memory while
running; source URLs/tokens in FFmpeg command-line arguments may be visible to
other users/processes with sufficient rights on the server. Server admins can
access files and may configure logs outside this project.

Users control the backend, may clear extension settings or uninstall the add-on,
and can delete job files/videos on their server. Captured streams can be cleared
from the popup, and capture is off by default. No automatic retention deadline
is imposed on user-owned downloads or locally stored settings.

For privacy/security questions please contact the project maintainer through
the repository's GitHub Issues (never post private URLs/tokens publicly).


### v2.2 encrypted downloads and deduplication

Remote jobs store a SHA-256 digest of the complete playlist URL (never the original URL or request headers) to recognize repeat downloads. Hash digests can potentially be guessed for predictable URLs; API access remains authenticated. Encrypted files are stored on the user's server and decrypted using an independent private key file held by the server owner. The server does not transmit this key via its API. The separate downloads tab displays job metadata only.
