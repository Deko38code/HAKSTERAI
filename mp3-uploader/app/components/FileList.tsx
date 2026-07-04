'use client';

import { AudioFile } from '../types';
import { formatDuration, formatFileSize } from '../utils/audioUtils';

interface FileListProps {
  files: AudioFile[];
  currentPlayingId: string | null;
  onPlay: (file: AudioFile) => void;
  onDelete: (id: string) => void;
}

export default function FileList({ files, currentPlayingId, onPlay, onDelete }: FileListProps) {
  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <svg
          className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
          />
        </svg>
        <p className="text-lg">No music files uploaded yet</p>
        <p className="text-sm mt-2">Upload some MP3 files to get started</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
        Your Music ({files.length})
      </h2>
      
      {files.map((file) => (
        <div
          key={file.id}
          className={`bg-white dark:bg-gray-800 rounded-lg p-4 shadow transition-all ${
            currentPlayingId === file.id
              ? 'ring-2 ring-blue-500'
              : 'hover:shadow-md'
          }`}
        >
          <div className="flex items-center gap-4">
            <button
              onClick={() => onPlay(file)}
              className="flex-shrink-0 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center transition-colors"
            >
              {currentPlayingId === file.id ? (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-gray-900 dark:text-white truncate">
                {file.title || file.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {file.artist} • {formatDuration(file.duration)} • {formatFileSize(file.size)}
              </p>
            </div>

            <button
              onClick={() => onDelete(file.id)}
              className="flex-shrink-0 p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              title="Delete"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
