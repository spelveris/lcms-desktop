# Windows Trusted Signing Setup

This workflow can sign the published Windows installer with Microsoft's Trusted
Signing action so Windows 11 Smart App Control is less likely to block the app.

The workflow step is optional. If the configuration below is missing, Windows
builds still complete, but the installer is published unsigned.

GitHub secrets required:
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`

GitHub repository variables required:
- `WINDOWS_TRUSTED_SIGNING_ENDPOINT`
- `WINDOWS_TRUSTED_SIGNING_ACCOUNT_NAME`
- `WINDOWS_TRUSTED_SIGNING_CERT_PROFILE_NAME`

Expected endpoint format:
- `https://<region>.codesigning.azure.net/`
- Example: `https://eus.codesigning.azure.net/`

What the workflow signs:
- `release/*Setup*.exe`

What it does not sign yet:
- unpacked intermediate Windows app binaries before NSIS packaging
- zip artifacts

That means this change is targeted at the installer users actually download from
GitHub Releases. If later needed, the next step would be wiring signing earlier
in the Windows packaging flow so the packaged app binaries are also signed
before the installer and zip are created.
