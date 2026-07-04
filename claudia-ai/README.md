# Claudia AI - AI Application Builder

An intelligent AI-powered application builder that helps you create web applications through natural conversation.

## Features

- 🤖 **AI-Powered Chat Interface** - Describe what you want to build in plain English
- ⚡ **Real-time Code Generation** - Watch your code being generated instantly
- 🎨 **Multiple Templates** - Choose from React, Next.js, Node.js, and more
- 💻 **Live Code Preview** - See your generated code in real-time
- 📥 **Export & Download** - Download your generated code instantly
- 🎯 **Modern UI** - Beautiful, responsive design with Tailwind CSS
- 🌙 **Dark Mode** - Automatic dark mode support

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI**: React 19

## Getting Started

### Prerequisites

- Node.js 18+ installed
- npm or yarn package manager

### Installation

1. Install dependencies:
```bash
npm install
```

2. Run the development server:
```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000) in your browser

### Build for Production

```bash
npm run build
npm start
```

## Project Structure

```
claudia-ai/
├── app/
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Home page
│   └── globals.css         # Global styles
├── components/
│   ├── Hero.tsx            # Landing page hero section
│   ├── BuilderInterface.tsx # Main builder interface
│   ├── ChatInterface.tsx   # AI chat component
│   ├── CodePreview.tsx     # Code preview component
│   └── TemplateSelector.tsx # Template selection
├── public/                 # Static assets
└── package.json           # Dependencies
```

## Available Templates

- **React Application** - Modern React app with hooks
- **Next.js Application** - Full-stack React framework
- **Node.js API** - RESTful API with Express
- **Landing Page** - Responsive landing page
- **Admin Dashboard** - Data visualization dashboard
- **E-commerce Store** - Online store with cart

## Usage

1. **Choose a Template** - Select from pre-built templates or start from scratch
2. **Chat with Claudia** - Describe what you want to build
3. **Review Generated Code** - See your code in the preview panel
4. **Export & Use** - Download your code and deploy anywhere

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Run linting
npm run lint
```

## License

MIT License - feel free to use this project for your own purposes.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
