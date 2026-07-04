# MP3 Music Uploader

A modern, responsive web application for uploading, managing, and playing MP3 music files. Built with Next.js, TypeScript, and Tailwind CSS.

## Features

- **Drag & Drop Upload**: Intuitive drag-and-drop interface for uploading MP3 files
- **File Validation**: Automatically validates and filters MP3 files only
- **Audio Player**: Custom-built audio player with:
  - Play/Pause controls
  - Seek bar for navigation
  - Volume control
  - Real-time progress tracking
- **File Management**: 
  - View all uploaded files with metadata
  - Display file size, duration, and artist information
  - Delete unwanted files
- **Metadata Extraction**: Automatically extracts audio duration and file information
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Dark Mode Support**: Automatic dark mode based on system preferences
- **Client-Side Storage**: All files are stored locally in your browser

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Icons**: Custom SVG icons (no external icon libraries)

## Getting Started

### Prerequisites

- Node.js 18+ installed
- npm or yarn package manager

### Installation

1. Navigate to the project directory:
```bash
cd mp3-uploader
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

### Building for Production

```bash
npm run build
npm start
```

## Usage

1. **Upload Files**: 
   - Drag and drop MP3 files onto the upload zone, or
   - Click "Browse Files" to select files from your computer

2. **Play Music**:
   - Click the play button on any file in the list
   - Use the audio player controls to play/pause, seek, and adjust volume

3. **Manage Files**:
   - View all uploaded files with their metadata
   - Click the delete icon to remove files

## Project Structure

```
mp3-uploader/
├── app/
│   ├── components/
│   │   ├── AudioPlayer.tsx    # Audio player component
│   │   ├── FileList.tsx       # File list display
│   │   └── FileUpload.tsx     # Upload interface
│   ├── utils/
│   │   └── audioUtils.ts      # Utility functions
│   ├── types.ts               # TypeScript type definitions
│   ├── page.tsx               # Main page
│   ├── layout.tsx             # Root layout
│   └── globals.css            # Global styles
├── public/                    # Static assets
├── package.json
└── tsconfig.json
```

## Features in Detail

### File Upload
- Supports multiple file selection
- Validates MP3 format
- Visual feedback during drag operations
- Progress indicator during processing

### Audio Player
- Custom-designed player interface
- Smooth progress bar with seek functionality
- Volume slider with visual feedback
- Displays current time and total duration
- Auto-stops on track end

### File List
- Grid layout with file cards
- Shows file metadata (title, artist, duration, size)
- Visual indicator for currently playing track
- Quick delete functionality
- Empty state with helpful message

## Browser Compatibility

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Notes

- All files are stored in browser memory (not persisted after page reload)
- No server-side storage or backend required
- Files are processed entirely client-side
- Maximum file size depends on browser memory limits

## License

MIT License - feel free to use this project for personal or commercial purposes.
