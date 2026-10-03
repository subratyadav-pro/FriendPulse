# 🛰️ FriendPulse - Real-Time Friend Location Tracker & Safety Mobile App

**FriendPulse** is a mobile application built with **Flutter (Dart)** designed to let you track your friends' live GPS locations, monitor safety status, set up geofence safe zones, and broadcast emergency SOS alerts.

---

## 📱 Key Features

1. **Live GPS Radar & Interactive Map**:
   - Built with high-performance vector tile maps (OpenStreetMap & CartoDB Dark/Light themes — no paid Google Maps API keys required!).
   - Glowing real-time user marker + friend avatar pins with battery %, speed, and status emoji indicators.
   - Smooth movement trail / breadcrumb polylines.

2. **Friend Circle & Invite Code Sharing**:
   - Unique 6-digit personal radar invite codes (`RADAR-XXXX`).
   - One-tap copy & instant share via WhatsApp, SMS, or Messenger.
   - Instant search and friend telemetry inspection.

3. **Friend Bottom Sheet Telemetry**:
   - Tap any friend on the map or list to view exact distance, travel speed, last updated time, and battery level.
   - **🗺️ Directions Button**: Instantly opens navigation directions in Google Maps / Apple Maps to their exact GPS coordinate.
   - **📞 Direct Call**: Quick dial friend's phone number.
   - **⚡ Ping / Nudge**: Request immediate high-accuracy GPS update.

4. **Emergency SOS Panic Beacon**:
   - 3-second hold/press countdown button to prevent accidental triggers.
   - Immediate broadcast of distress beacon to all paired friends.
   - 1-tap quick calling for Police (911) & Medical Ambulance.

5. **Safe Zones (Geofencing)**:
   - Create custom geofence safety zones (Home, Campus, Work, Gym) with customizable radius.
   - Entry and exit safety notifications.

6. **Ghost Mode (Stealth & Privacy)**:
   - Freeze your location broadcast while still keeping friends visible on your map.

---

## 📂 Project Architecture

```
e:/app for security/
├── lib/
│   ├── main.dart                      # Flutter app entry point & theme
│   ├── models/
│   │   ├── friend.dart                # Friend telemetry & location model
│   │   └── geofence.dart              # Geofencing safety zones model
│   ├── providers/
│   │   ├── location_provider.dart     # GPS tracking, SOS, and Ghost Mode provider
│   │   └── friends_provider.dart      # Friends state, list, & simulation provider
│   ├── screens/
│   │   ├── home_navigation.dart       # Modern bottom navigation tab bar
│   │   ├── map_screen.dart            # Interactive radar map & markers
│   │   ├── friends_screen.dart        # Friend circle, search & invite code sharing
│   │   ├── safety_screen.dart         # SOS panic beacon & safe zones
│   │   └── settings_screen.dart       # Privacy, ghost mode & profile settings
│   ├── services/
│   │   └── location_service.dart      # Device GPS stream & distance calculations
│   └── widgets/
│       ├── pulse_marker.dart          # Glowing pulsing user & friend map pins
│       ├── friend_bottom_sheet.dart   # Interactive detail & navigation sheet
│       └── friend_card.dart           # Quick friend list tile
├── android/
│   └── app/src/main/AndroidManifest.xml # Android GPS & Internet permissions
├── public/                            # Live Interactive Mobile Web preview
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server.js                          # Real-time WebSocket/REST relay server
└── pubspec.yaml                       # Flutter project dependencies
```

---

## 🚀 Running the App

### 1. Run React Native Android App (True Background GPS)
This native app uses `react-native-background-fetch` to update your location even when the app is closed.
```bash
cd FriendPulseApp
npx react-native run-android
```
*Note: Make sure your Android device is connected via USB and debugging is authorized.*

### 2. Instant Live Web Preview
A companion live server relays WebSocket locations and offers a PWA interface:
- Open your browser to: **`http://localhost:3000`**
- Or use the public `localtunnel` link generated when starting the server.

### 3. Run Flutter Mobile App (Alternative)
If you prefer the Flutter version (requires Flutter SDK):
```bash
flutter pub get
flutter run
```
