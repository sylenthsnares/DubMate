# Security

Found a security hole in DubMate? Report it privately, so it can be fixed before anyone else learns about it.

## How to report

Use GitHub's private reporting: on [sylenthsnares/DubMate](https://github.com/sylenthsnares/DubMate), open the **Security** tab and choose **Report a vulnerability**. Only you and the maintainers see the report.

Please don't open a public issue for a security problem.

Include what you found, how to reproduce it, which DubMate version and operating system you used, and what someone could do with it.

## What's in scope

- The DubMate engine's web and WebSocket server, as reached through a room's Cloudflare tunnel and over the local network. For example: a guest reading or changing files on the host's computer, or doing things only the host should do.
- The room registry (`worker/`, at `dubmate.bkaproductions.com`).
- The desktop app's updater and its Pack Builder installer.
- The desktop app's commands that the studio page can call.

## What isn't

Bugs in Cloudflare, GitHub, Python packages, FFmpeg and the other projects DubMate uses. Report those to the project concerned. If DubMate uses one of them in an unsafe way, that is in scope.

## Supported versions

Only the latest release gets security fixes. Update to it before reporting, and check the problem is still there.

## What to expect

- A reply to say the report has arrived.
- A fix in the next release, with a note in the [CHANGELOG](CHANGELOG.md).
- Credit in that note, if you'd like it.

DubMate is a hobby project, so there's no promised response time.
