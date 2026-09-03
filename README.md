# Teams Greens Everywhere

Teams Greens Everywhere provides scheduled Teams-presence support for Windows
native Teams and Teams on the web in Chrome or Firefox on Linux and Windows.

## Schedule

Set any number of on-periods for each day of the week. Every period has:

- a start and end time
- separately configurable start and end variation, both defaulting to 10 minutes
- a saved timezone detected during first setup, editable later

The app chooses each day’s varied start and end once, then saves them. Restarting
the Windows app or browser does not choose a new time. A period whose end time
is earlier than its start time runs overnight.

## Windows native Teams

The Windows tray menu offers Start, Stop, Run Once Now, Settings, and Exit.
When a scheduled period is active, it sends a reversible Scroll Lock signal.
The signal leaves Scroll Lock in its original state.

Install from **Windows PowerShell**:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/windows/install.ps1 | powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -
```

It installs for the current user only, starts immediately, and starts again at
Windows sign-in. No administrator access is required.

## Teams on the web

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Firefox.
2. Open [the userscript](https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js) and confirm its single install prompt.
3. Keep a signed-in Teams tab open. It may remain unfocused in the background.

Tampermonkey’s menu provides Start / Stop, Status, and Settings. During active
periods, the script attempts to restore an `Away` status to `Available`.

## Publish on Greasy Fork

The installable Greasy Fork file is the readable, self-contained
[`dist/teams-greens-everywhere.user.js`](dist/teams-greens-everywhere.user.js).
It has no external `@require` dependency.

1. On Greasy Fork, select **Public user script**.
2. Open the [published build source](https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js), copy all of it, and paste it into Greasy Fork's script-code field.
3. Review the automatically read metadata and publish.

GitHub Actions verifies that the committed distribution file matches the
readable source on every push. Tampermonkey updates installed copies from the
GitHub build URL in the userscript metadata.

## Windows suppresses web

When the Windows tray app is actively handling a scheduled period, the
userscript detects its status through a loopback-only endpoint and pauses.
When Windows is stopped or outside its schedule, the web script resumes. On
Linux, where the Windows companion is not present, the web script works on its
own.

## Limits

This project does not use a Microsoft Teams API. Teams UI changes and account
or organization policies can prevent the web integration from working.

## License and attribution

This project is released under the [Unlicense](LICENSE). The original Teams
Always Green MIT license copy is retained in
[licenses/Teams-Always-Green-MIT.txt](licenses/Teams-Always-Green-MIT.txt).
