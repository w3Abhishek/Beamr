# Beamr

![Beamr Logo](media/icon.png)

Beamr moves a file from a VSCode workspace to another device using only a screen and a camera. No network call is ever made by either side.

## Features

- **Zero Network Configuration**: Completely decentralized. If you have a screen and a camera, you have a transfer link.
- **Offline Capable**: After the initial load of the static website, everything runs locally. No data ever leaves your devices.
- **Lightning Fast Extraction**: Built with high-performance WebAssembly (`jsQR`) and blazing fast `pako` zlib compression.
- **Folder Support (New in v1.0.1)**: Send entire directories seamlessly! The extension dynamically compresses your folder into a `.zip` archive on the fly and transfers it flawlessly to your device.
- **Redesigned SaaS UI (New in v1.0.1)**: A stunning, glassmorphism-inspired dark theme for both the VSCode editor tab and the receiver website.
- **Large QR Canvas**: Full-editor panel layout to maximize the QR code size, making scanning effortless even from a distance. The channel is strictly one-directional (sender can't see the receiver).

## How it Works (Protocol)

Since the transfer is strictly one-directional, the sender does not know if the receiver is actually getting the data. Thus:
1. The sender compresses the file (using `pako`), converts the payload to base64, chunks it into small segments (default ~700 base64 chars), and loops over them continuously.
2. The sender occasionally interweaves a **header frame** containing metadata (filename, MIME type, number of chunks, and a SHA-256 hash prefix of the compressed payload).
3. The receiver scans the QR codes continuously. Once it spots a new header frame, it prepares to receive chunks.
4. The receiver collects chunks by index. Since they are looped infinitely, out-of-order and dropped frames don't break the transfer—the receiver just waits for that chunk to come around again.
5. Once all chunks are collected, the receiver reconstructs the base64 string, verifies the SHA-256 hash prefix, decompresses the payload, and provides a download button.

## Running the VSCode Extension

1. Open the `extension` folder in VSCode.
2. Ensure you have the dependencies: `npm install` inside the `extension` directory.
3. Press `F5` to open the Extension Development Host.
4. In the new VSCode window, right-click any file in the explorer (e.g. a `.ts` or `.json` file) and choose **Share with Beamr**.
5. The Beamr sidebar will open. You can adjust the QR interval (ms) and chunk size.
6. Click **Start Transfer** to begin the QR loop.

## Running the Receiver

The receiver is a static HTML/JS/CSS website and has zero build steps. All dependencies (`jsQR`, `pako`) are bundled inside the `lib` folder.

1. Serve the `receiver` folder using any static web server.
   For example, using Python:
   ```bash
   cd receiver
   python3 -m http.server 8000
   ```
2. **Important Note:** Browsers require HTTPS to grant camera access (`getUserMedia`), unless you are accessing `localhost`. If you are testing from your mobile phone, you must either:
   - Deploy the receiver to a static host with HTTPS (like GitHub Pages or Vercel).
   - Use a tool like `ngrok` or Cloudflare Tunnels to expose your local server over HTTPS.
   - Use VSCode port forwarding and access the forwarded HTTPS URL on your phone.
3. Open the receiver website on your phone, click **Enable Camera**, and point it at the VSCode screen.
4. When the file transfer completes, tap **Download File**.
