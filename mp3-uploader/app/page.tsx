'use client';

import { useState, useCallback } from 'react';
import FileUpload from './components/FileUpload';
import AudioPlayer from './components/AudioPlayer';
import FileList from './components/FileList';
import { AudioFile } from './types';
import { extractAudioMetadata } from './utils/audioUtils';

export default function Home() {
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [currentPlaying, setCurrentPlaying] = useState<AudioFile | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setIsUploading(true);
    
    const newAudioFiles: AudioFile[] = [];
    
    for (const file of files) {
      const metadata = await extractAudioMetadata(file);
      const audioFile: AudioFile = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: file.name,
        size: file.size,
        duration: metadata.duration,
        file: file,
        url: URL.createObjectURL(file),
        title: metadata.title,
        artist: metadata.artist,
      };
      newAudioFiles.push(audioFile);
    }
    
    setAudioFiles(prev => [...prev, ...newAudioFiles]);
    setIsUploading(false);
  }, []);

  const handlePlay = useCallback((file: AudioFile) => {
    setCurrentPlaying(file);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setAudioFiles(prev => {
      const fileToDelete = prev.find(f => f.id === id);
      if (fileToDelete) {
        URL.revokeObjectURL(fileToDelete.url);
      }
      return prev.filter(f => f.id !== id);
    });
    
    if (currentPlaying?.id === id) {
      setCurrentPlaying(null);
    }
  }, [currentPlaying]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            MP3 Music Uploader
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Upload, manage, and play your MP3 music collection
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                Upload Music
              </h2>
              <FileUpload onFilesSelected={handleFilesSelected} />
              {isUploading && (
                <div className="mt-4 text-center">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                    Processing files...
                  </p>
                </div>
              )}
            </div>

            {currentPlaying && (
              <AudioPlayer
                audioUrl={currentPlaying.url}
                fileName={currentPlaying.title || currentPlaying.name}
              />
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
            <FileList
              files={audioFiles}
              currentPlayingId={currentPlaying?.id || null}
              onPlay={handlePlay}
              onDelete={handleDelete}
            />
          </div>
        </div>

        <footer className="mt-12 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>All files are stored locally in your browser</p>
        </footer>
      </div>
    </div>
  );
}
