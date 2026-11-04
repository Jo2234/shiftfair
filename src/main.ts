import './styles.css';
import { mountApp } from './ui/app.ts';
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  }
  catch {
    return null;
  }
}
function browserDownload(filename: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], {
    type: mime
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
mountApp(document.getElementById('app')!, {
  storage: safeLocalStorage(), download: browserDownload
});
