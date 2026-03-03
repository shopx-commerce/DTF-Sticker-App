import { useCallback, useState } from "react";
import { Upload, Sparkles, Image, FileText } from "lucide-react";
import { parsePDF, isPDFFile, type ParsedPDFData } from "@/lib/pdf-parser";
import type { ImageInfo, ResizeSettings } from "./image-editor";

interface UploadSectionProps {
  onImageUpload: (file: File, image: HTMLImageElement) => void;
  onPDFUpload?: (file: File, pdfData: ParsedPDFData) => void;
  showCutLineInfo?: boolean;
  imageInfo?: ImageInfo | null;
  resizeSettings?: ResizeSettings | null;
  stickerSize?: number;
}

export default function UploadSection({ onImageUpload, onPDFUpload, showCutLineInfo = false, imageInfo, resizeSettings, stickerSize }: UploadSectionProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFileUpload = useCallback(async (file: File) => {
    if (isPDFFile(file)) {
      if (onPDFUpload) {
        try {
          const pdfData = await parsePDF(file);
          onPDFUpload(file, pdfData);
        } catch (error) {
          console.error('Error parsing PDF:', error);
          alert('Error parsing PDF file. Please try a different file.');
        }
      } else {
        alert('PDF upload not supported.');
      }
      return;
    }
    
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file (PNG, JPEG) or PDF.');
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      onImageUpload(file, img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('Failed to load image. Please try a different file.');
    };
    img.src = url;
  }, [onImageUpload, onPDFUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  }, [handleFileUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  }, [handleFileUpload]);

  const isEmptyState = !imageInfo;

  return (
    <div className="w-full">
      {isEmptyState ? (
        <div 
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => document.getElementById('imageInput')?.click()}
          className={`
            relative overflow-hidden rounded-2xl text-center cursor-pointer
            transition-all duration-300 ease-out
            bg-gradient-to-br from-indigo-50 via-white to-violet-50
            border-2 border-dashed
            ${isDragOver 
              ? 'border-indigo-500 shadow-xl shadow-indigo-500/20 scale-[1.01]' 
              : 'border-indigo-200/60 hover:border-indigo-400 hover:shadow-xl hover:shadow-indigo-500/10'
            }
            p-10 sm:p-14
          `}
        >
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)',
            backgroundSize: '24px 24px',
          }} />

          <div className="relative flex flex-col items-center gap-5">
            <div className={`
              relative w-20 h-20 rounded-2xl
              bg-gradient-to-br from-indigo-500 to-violet-600
              flex items-center justify-center
              shadow-lg shadow-indigo-500/30
              transition-transform duration-300
              ${isDragOver ? 'scale-110 rotate-3' : 'hover:scale-105'}
            `}>
              <Upload className="w-9 h-9 text-white" strokeWidth={2} />
              <div className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-amber-400 flex items-center justify-center shadow-sm">
                <Sparkles className="w-3.5 h-3.5 text-amber-900" />
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-800 tracking-tight">
                Upload your Design
              </h2>
              <p className="text-sm sm:text-base text-indigo-500/80 font-medium">
                Create the perfect sticker
              </p>
            </div>

            <div className="flex items-center gap-3 mt-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/80 border border-slate-200/60 shadow-sm">
                <Image className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-500 font-medium">PNG, JPEG</span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/80 border border-slate-200/60 shadow-sm">
                <FileText className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-500 font-medium">PDF</span>
              </div>
            </div>

            <p className="text-xs text-slate-400 mt-1">
              Drag & drop or click to browse
            </p>
          </div>
        </div>
      ) : (
        <div 
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => document.getElementById('imageInput')?.click()}
          className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-400 hover:to-violet-400 px-4 py-2 rounded-xl shadow-lg shadow-indigo-500/30 hover:shadow-indigo-400/40 cursor-pointer transition-all duration-200 text-center"
        >
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-white" />
            <p className="text-white text-sm font-medium">Change Design</p>
          </div>
        </div>
      )}
      <input 
        type="file" 
        id="imageInput" 
        className="hidden" 
        accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" 
        onChange={handleFileInputChange}
      />
    </div>
  );
}
