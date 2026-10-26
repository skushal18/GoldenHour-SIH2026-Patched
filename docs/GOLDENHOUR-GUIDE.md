# GoldenHour — links and quick guide

## Links

| What | Link | Who uses it |
|---|---|---|
| Home page | https://d1k7k7ahunvfhc.cloudfront.net/ | Everyone |
| **Admin console** (sign in) | https://d1k7k7ahunvfhc.cloudfront.net/admin/ | GoldenHour administrator |
| **ER desk** (sign in) | https://d1k7k7ahunvfhc.cloudfront.net/hospital/ | Hospital emergency teams |
| **Hospital activation** (first time only) | https://d1k7k7ahunvfhc.cloudfront.net/hospital/#activate | A hospital with an activation code |
| **Ambulance app** (in a browser) | https://d1k7k7ahunvfhc.cloudfront.net/ambulance/ | Ambulance crews |
| Ambulance app (Android APK) | GitHub → Actions → **Build GoldenHour APK** → latest run → `goldenhour-apk` | Ambulance crews |
| Server status | https://d1k7k7ahunvfhc.cloudfront.net/health | Administrator |
| Wake the server | https://d1k7k7ahunvfhc.cloudfront.net/wake | Anyone (see "Sleeping" below) |

The admin console and the ER desk share one sign-in page: the account decides which opens. An administrator lands on the console; a hospital login lands on its own ER desk.

## Sign in as administrator (first time)

1. Open the AWS console, region **Asia Pacific (Sydney)**, then **Secrets Manager** → secret **`goldenhour/app`** → **Retrieve secret value**.
2. Note `SUPER_ADMIN_USERNAME` (it is `admin`) and `SUPER_ADMIN_PASSWORD`.
3. Open https://d1k7k7ahunvfhc.cloudfront.net/admin/ and sign in with them.
4. You are asked to choose a new password straight away (at least 10 characters, not containing the username). Keep it safe — from now on you sign in with it. The secret is not updated and is not used again.

Forgot the administrator password? Ask whoever manages AWS: it can be reset on the server (see `deploy/aws/README.md`).

## Give the hospitals their logins

1. In the admin console: **Hospital accounts** → **Create logins for all hospitals** → confirm.
2. A file `goldenhour-activation-codes-<date>.csv` downloads. It has one row per hospital: name, district, phone, **activation code**, expiry and the activation link. It is shown **once only** — store it privately, delete it when the hospitals have activated.
3. Send each hospital **its own code** and the link https://d1k7k7ahunvfhc.cloudfront.net/hospital/#activate (phone or a private message — the code is a password).
4. Codes work **once** and expire after **7 days**. For a lost or expired code: **Hospital accounts** → find the hospital → **Re-issue code** (the old code stops working).

The list shows each hospital's status: **Pending activation**, **Activation code expired**, **Active**, **Locked** (5 wrong passwords — unlocks after 15 minutes) or **Disabled**.

One hospital at a time: the form on the right (**Create a hospital login**) — choose *Activation code* (the hospital picks its own username and password) or *Temporary password* (you pick the username; they change the password at first sign-in).

## Activate a hospital (for the hospital's ER team)

1. Open https://d1k7k7ahunvfhc.cloudfront.net/hospital/#activate (or the ER desk sign-in page → *Activate your hospital's login with its activation code*).
2. Type the **activation code** (16 letters and digits, like `7K3Q-PX9M-2DHT-W4RB`; capitals and dashes do not matter) → **Continue**. The page shows which hospital the code is for — check it is yours.
3. Choose a **username** (3–64 characters: letters, digits, dot, dash or underscore — e.g. `stjohns.er`) and a **password** (at least 10 characters, not containing the username; a short sentence is easiest). Type the password twice.
4. **Activate and open the ER desk.** You are signed in to your hospital's desk.
5. From now on sign in at https://d1k7k7ahunvfhc.cloudfront.net/hospital/ with exactly that username and password. Leave the desk open on the ER screen; it shows new cases with a sound.

On the desk: **Accept** a case to take the patient (the first hospital to accept gets it), watch the ambulance on the map, mark **Arrived**. A desk only ever sees cases offered to its own hospital.

## Ambulance crews

1. Open https://d1k7k7ahunvfhc.cloudfront.net/ambulance/ on the phone (or install the APK). No sign-in.
2. **Start new alert** → case type, patient details → **Send**. Allow location, or enter coordinates by hand.
3. The case goes to every hospital **with an active GoldenHour login** within the chosen radius (15 km by default) — so a hospital must have activated before it can receive cases. If none is in range, the app lists nearby hospitals to phone.

## Sleeping (saves money)

After **2 hours with no use**, GoldenHour puts its server to sleep and stops the database. Pages still open; the first sign-in, desk or ambulance request wakes it, and it is back in **about 8–10 minutes** (the page says it is starting up and reconnects by itself). A case sent from the ambulance app while it sleeps waits in the app and is sent once the server is up. An open ER desk keeps it awake. To wake it ahead of a demo, open https://d1k7k7ahunvfhc.cloudfront.net/wake and wait 10 minutes.
