# Phone Wheel

Use an Android phone as a steering wheel (tilt) with pedals and buttons for Euro Truck Simulator 2 on Windows. The PC shows up to the game as a normal Xbox 360 controller.

```
phone (Chrome)  --Wi-Fi, WebSocket-->  server.py  -->  virtual Xbox 360 pad (ViGEmBus)  -->  ETS2
```

## Setup (Windows PC, once)

1. Install Python 3.10+ (tick "Add to PATH").
2. Install the **ViGEmBus** driver: https://github.com/nefarius/ViGEmBus/releases
3. In this folder:
   ```
   pip install -r requirements.txt
   ```

## Run

```
python server.py
```

It prints a URL like `https://192.168.1.20:8443`. On the phone (same Wi-Fi) open it in Chrome. Chrome warns about the certificate: **Advanced → Proceed**. The certificate is self-signed on purpose; phone sensors only work over HTTPS. If Windows Firewall asks, allow Python on private networks.

On the phone: tap **Fullscreen**, hold it sideways like a wheel, tap **Centre** while the wheel is straight.

## Map the controls in ETS2

Options → Controls → choose the gamepad as the device, then bind:

| Phone | Pad input |
|---|---|
| Tilt | Left stick X (steering) |
| GAS | Right trigger |
| BRAKE | Left trigger |
| Indicators | LB / RB |
| Horn / Lights | Y / X |
| Engine / Park brake | A / B |
| Gear + / − | D-pad up / down |

If ETS2 ignores the steering, bind it in-game: select Steering, then tilt the phone.

## Settings (phone, ⚙ Settings)

Full lock angle (how far you turn for full steering), dead zone, smoothing, invert, and analog pedals (touch height = how hard you press). Saved on the phone.

## Testing without a PC game

`python server.py --dry-run` skips the virtual controller and prints what it receives. Works on any OS.

## Notes

- Keep the phone on the same network as the PC; there is no login, so use it on a trusted network.
- If the phone disconnects, all inputs reset to neutral.
- Steering is backwards? Turn on **Invert steering**.
