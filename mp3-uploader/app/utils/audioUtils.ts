export const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

export const extractAudioMetadata = async (file: File): Promise<{
  duration: number;
  title?: string;
  artist?: string;
}> => {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    
    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration;
      URL.revokeObjectURL(url);
      
      // Extract title from filename (remove extension)
      const title = file.name.replace(/\.[^/.]+$/, '');
      
      resolve({
        duration,
        title,
        artist: 'Unknown Artist'
      });
    });
    
    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      resolve({
        duration: 0,
        title: file.name.replace(/\.[^/.]+$/, ''),
        artist: 'Unknown Artist'
      });
    });
    
    audio.src = url;
  });
};
