# Beta deployment notes

The analytics admin service binds only to the VPS loopback interface on port `3004`. It is not routed through `beta.near-autopilot.tech`.

`setup-beta.sh` generates a separate `ADMIN_API_TOKEN` (at least 32 characters) for new and existing installs. Open an SSH tunnel from your workstation:

```sh
ssh -N -L 3014:127.0.0.1:3004 <user>@<vps-host>
```

Then open `http://127.0.0.1:3014/admin`. Keep the tunnel open while using the page.
