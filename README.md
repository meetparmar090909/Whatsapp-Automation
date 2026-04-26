# WhatsApp Automation Dashboard

A professional, cross-platform Desktop application for bulk WhatsApp messaging and database management built with Electron and Node.js.

## Features

- **WhatsApp Automation**: Send bulk text and media messages seamlessly without manual intervention.
- **Access Database Integration**: Read and update directly from Microsoft Access databases (`COPIM.accdb` / `.mdb`) for message queuing and delivery tracking.
- **Anti-Block Protection**: Configurable safety delays between messages with randomization to prevent account blocking.
- **Attachment Support**: Send files and documents (images, PDFs, etc.) directly from localized directories based on database entries.
- **QR Code Linking**: Easy scanning via WhatsApp Linked Devices with visual connection status updates.
- **Real-Time Analytics**: Visual tracking of Pending, Delivered, and Failed messages in an aesthetic, modern dashboard.
- **Priority Queuing**: Supports instant messaging overrides (Priority 0) over standard queued messages.
- **Modern UI**: Dark/Light mode, animated backgrounds, live terminal logs, and system tray integration.

## Tech Stack

- **Frontend**: HTML5, Vanilla JS, CSS (Modern glassmorphism and animated UI).
- **Backend/Desktop**: Electron, Node.js (`main.js`).
- **WhatsApp Web Interface**: `whatsapp-web.js` & `puppeteer`.
- **Database**: `mdb-reader` for pure JS fast reading and `node-adodb` for database writes via VBScript/cscript.

## Prerequisites

- **Node.js**: v18 or newer recommended.
- **Windows OS**: Recommended due to Microsoft Access DB (`.accdb`, `.mdb`) dependencies.

## Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   git clone <repository_url>
   cd "Whatsapp Automation"
   ```

2. Install dependencies:
   ```bash
   npm install
   ```
   > **Note**: This will automatically trigger `puppeteer browsers install chrome` during the post-install process.

## Usage

### Running Locally (Development)
To start the application in development mode:
```bash
npm run dev
```
Or just:
```bash
npm start
```

### Database Setup
The application looks for a specific Microsoft Access Database file (e.g., `COPIM.accdb` or `Pharma2425.mdb`). It expects a `SendQ` table with the following core fields:
- `OutId`: Primary Key
- `CellNo`: WhatsApp number (e.g., `919876543210`)
- `MsgStr`: The message body/caption
- `Priority`: Numeric priority (0 for instant urgent messages)
- `AttachmentId`: Linked to a `SendQAttachment` table for file names.
- `Status`: Message delivery status (`s` for sent, `f` for failed, `INVALID` for bad number).

### Build for Production
To build the application for Windows (x64) into an executable:
```bash
npm run build
```

## How It Works

1. **Launch & Connect**: Open the application, view the QR code in the "Link WhatsApp" panel, and scan it from your mobile device.
2. **Dashboard Overview**: Once connected, the dashboard visualizes queue statistics.
3. **Processing**: The application reads pending rows from the database. It will send them out sequentially based on the safety delay settings (default 60-120 seconds).
4. **Attachments**: If an attachment is specified, the application will look for it in the `attachments` folder (or fallback to the root dir) and send it with the text as a caption.
5. **Status Update**: Upon success or failure, the application writes back the status (`s`, `f`) and timestamps directly into the MS Access Database.

## License

© Infosoft. All rights reserved.
