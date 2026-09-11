# Demo-day runbook

Three machines, one Wi-Fi network, about ten minutes.

> Deploying to a real server instead? That is [DEPLOYMENT.md](DEPLOYMENT.md).
> This file is the hackathon demo only.

| machine | role | what to open |
|---|---|---|
| any laptop | **server** | runs `npm run demo` |
| laptop 1 | **hospital A** | `http://<server-ip>:5000/hospital` |
| laptop 2 | **hospital B** | `http://<server-ip>:5000/hospital` |
| phone or a fourth browser | **ambulance** | `http://<server-ip>:5000/ambulance` (or the APK) |

The server laptop can also be one of the two hospital laptops. Everything just
has to be on the same network.

---

## 1 · Find the two laptop IPs

On **each hospital laptop**:

| OS | command | what you want |
|---|---|---|
| Windows | `ipconfig` | "IPv4 Address" under the Wi-Fi adapter |
| macOS | `ipconfig getifaddr en0` | the whole output |
| Linux | `hostname -I` | the first address |

You are looking for something like `192.168.1.101` — a private address, usually
starting `192.168.`, `10.` or `172.`.

## 2 · Write them into the config

On the **server** machine, open `config/hospitals.config.js` and edit two lines:

```js
{ hospital_id: 1, ip: '192.168.1.101', name: 'City Emergency Hospital', ... },
{ hospital_id: 2, ip: '192.168.1.102', name: 'Apollo Hospital',        ... }
```

Change the names too if the judges would rather see local hospitals.

## 3 · Start the server

```bash
npm run setup      # first time only
npm run demo
```

It prints the addresses to hand out:

```
──────────────────────────────────────────────────────────────────
  🚑  GoldenHour  ·  master server
──────────────────────────────────────────────────────────────────
  This machine on the LAN :  192.168.1.100

  Open on the HOSPITAL laptops :  http://192.168.1.100:5000/hospital
  Open on the AMBULANCE device :  http://192.168.1.100:5000/ambulance

  Hackathon mode          :  ON — every broadcast alerts BOTH laptops
    #1  192.168.1.101    City Emergency Hospital
    #2  192.168.1.102    Apollo Hospital
──────────────────────────────────────────────────────────────────
```

`npm run demo` skips MySQL entirely. Use `npm start` if you want the database
(see the README).

## 4 · Open the boards

On each hospital laptop, open `http://<server-ip>:5000/hospital`.

Each should show **its own hospital name** and a green **Live** pill. Under the
name it says how it was identified:

* *matched by IP* — the config is right, you are done
* *set by hand* — you used `?hospital=1`, fine
* *assumed* + a yellow warning bar — the IP is not in the config

If you get the warning bar, either fix the IP in `config/hospitals.config.js`
and restart, or click **I am hospital 1** / **I am hospital 2** in the bar.
Both work; the config is tidier.

## 5 · Run the demo

1. On the ambulance device, tap a case (say **Stroke**), add a couple of
   vitals, press **Broadcast Request**.
2. Both laptops chime and show the same card at the same moment — priority
   badge, vitals coloured, FAST panel, crew note, a countdown.
3. Press **Accept patient** on **one** laptop.
4. That laptop moves the case to *Accepted here — patient is ours*.
5. The other laptop's card slides away, labelled **Taken by …**.
6. The ambulance screen turns to **✓ Accepted by …** with Call ER and Navigate
   buttons.

That is the whole story. It takes about twenty seconds to show.

---

## If something goes wrong

**A laptop shows the wrong hospital.** Open `/hospital?hospital=1` or
`?hospital=2` on it. Takes effect immediately.

**A laptop shows "Server unreachable".** It is on a different network, or a
firewall is blocking port 5000. On Windows, allow Node through the private
network when prompted. Check with `http://<server-ip>:5000/health` in the
laptop's browser.

**The pill says "Polling only" or "Offline".** WebSockets are blocked. The
board still works — it polls every 5 seconds, so cards appear and disappear a
few seconds later rather than instantly. Nothing is lost.

**Nothing appears on either board.** Check the server console: every broadcast
logs a line like `📡 GH-2026-0001 RED "Stroke …" → #1 City Emergency Hospital +
#2 Apollo Hospital`. If that line is missing, the ambulance never reached the
server; if it is there, the laptops are not connected.

**The ambulance app says "Demo mode".** It could not resolve a server. Open it
from `http://<server-ip>:5000/ambulance`, or — for the APK — rebuild it with the
server address filled into the **Build GoldenHour APK** workflow (Actions tab),
or set `SERVER_BASE` in `app/www/config.js` by hand. The phone's browser works
just as well as the APK for a demo, GPS and camera included.

**The ambulance app will not send — "set a starting point".** GPS was refused,
which is normal in a phone browser on a plain-http LAN address (Chrome only
gives location to secure origins). Tap the preset chip under the location box,
or type coordinates. The APK does not have this problem. Change the preset to
your city in `app/www/config.js` → `FALLBACK_ORIGIN`.

**The board is silent when a case arrives.** Browsers will not play audio
until the page has been clicked once. Click anywhere on the board after
opening it — the bell icon is a good place, it plays a test chime.

**Cases keep expiring.** The accept window is 5 minutes. Change
`ACCEPT_WINDOW_SECONDS` in `config/hospitals.config.js`.

**Rehearsing alone on one machine.** Open two browser windows,
`/hospital?hospital=1` and `/hospital?hospital=2`. The race works exactly the
same — the server cannot tell the difference.

---

## Rehearsal checklist

- [ ] All machines on the same Wi-Fi, and it is not a guest network with client isolation
- [ ] The two IPs in `config/hospitals.config.js` match what the laptops report
- [ ] Both boards show different hospital names and a **Live** pill
- [ ] A test broadcast appears on both boards
- [ ] Accepting on one clears the other
- [ ] Sound is on (the bell icon in the desk bar), clicked once, and the laptop is not muted
- [ ] `FALLBACK_ORIGIN` in `app/www/config.js` points at your city, in case GPS is refused
- [ ] Browser zoom set so a card is readable from where the judges stand
