# WhatsAppSwift ⚡

**A WhatsApp Status Downloader for Chrome**

WhatsAppSwift is a Chrome extension designed to simplify saving viewable WhatsApp Status media. Its primary goal is to help users collect and download multiple available Status photos and videos in bulk, rather than saving each item individually.

## ✨ Features

### 📦 Bulk Status Download
- Detect available Status photos and videos while using WhatsApp Web.
- Collect multiple available Status items in one session.
- Download supported Status media in bulk.
- Reduce repetitive manual downloads.
- Organize downloaded media through Chrome's download system.

### 📥 Individual Status Download
- Download a particular Status photo.
- Download a particular Status video.
- Save supported media individually when bulk downloading is not needed.

### ⚡ Additional Features
- Chrome Extension Manifest V3.
- JavaScript, HTML, and CSS implementation.
- Browser-based media detection.
- Background download handling.
- Simple extension interface.

## 🛠️ Built With

- JavaScript
- HTML5
- CSS3
- Chrome Extensions API
- Chrome Extension Manifest V3

## 📂 Project Structure

```text
WhatsAppSwift/
├── icons/
├── background.js
├── content.js
├── interceptor.js
├── manifest.json
├── offscreen.html
├── offscreen.js
├── popup.html
├── popup.js
└── style.css
```

## 🚀 Installation

1. Download or clone this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `WhatsAppSwift` folder.
6. Open WhatsApp Web and sign in normally.
7. Open the Status section and use the extension's available download controls.

## 📖 How to Use

### Bulk Status Download

1. Open WhatsApp Web.
2. Navigate to the Status section.
3. View the Status items you want to save so their media becomes available to the browser.
4. Use WhatsAppSwift's bulk download feature, if available in your installed version.
5. Save the detected media through Chrome's download system.

### Individual Status Download

1. Open the desired Status.
2. Use the individual download option, if available.
3. Save the supported photo or video.

## ⚠️ Limitations

- Download support depends on WhatsApp Web's current interface and media-loading behavior.
- Expired or inaccessible Status items may not be available.
- Some media may need to be viewed before it can be detected.
- WhatsApp Web updates can affect extension compatibility.
- Bulk downloads can only include media the extension successfully detects and resolves.

## 🔐 Privacy

WhatsAppSwift is intended to operate through the user's browser session. Review the source code and requested permissions before installing the extension.

Never share your WhatsApp authentication tokens, session data, or QR-login information with third parties.

## ⚖️ Disclaimer

WhatsAppSwift is an independent, third-party project. It is not affiliated with, endorsed by, or officially connected to WhatsApp or Meta.

Use the extension responsibly and respect other people's privacy. Save Status media only when you have the appropriate permission.

## 📄 License

See the [LICENSE](LICENSE) file for licensing details.

---

**WhatsAppSwift — Save Available Status Media, Simply.**
