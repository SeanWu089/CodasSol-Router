# Install the iPad controller

Use [NO-XCODE-GUIDE.md](NO-XCODE-GUIDE.md) for the cloud build and installation steps. The workflow runs inside `SeanWu089/CodasSol-Router`; no separate repository or local Xcode installation is needed.

The Actions artifact is `CodasSol-iPad-unsigned-IPA`, containing `CodasSol-iPad-Controller-unsigned.ipa`. It must be signed before installation, for example using [Sideloadly](https://sideloadly.io/) on your own Mac or Windows computer.

If full Xcode is already installed locally, `bash BUILD-IPA.command` uses the same build script and produces the same filename. Source archives and patches are not precompiled IPA files. Follow the Router setup in [README.md](README.md) after installation.
