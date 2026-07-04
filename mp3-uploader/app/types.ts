export interface AudioFile {
  id: string;
  name: string;
  size: number;
  duration: number;
  file: File;
  url: string;
  artist?: string;
  title?: string;
}
