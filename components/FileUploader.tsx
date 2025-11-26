import React, { useCallback } from 'react';

interface FileUploaderProps {
  onFilesSelected: (files: File[]) => void;
  isLoading: boolean;
}

const FileUploader: React.FC<FileUploaderProps> = ({ onFilesSelected, isLoading }) => {
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (isLoading) return;
      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        onFilesSelected(droppedFiles);
      }
    },
    [onFilesSelected, isLoading]
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
    }
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${
        isLoading
          ? 'bg-gray-50 border-gray-300 cursor-not-allowed opacity-50'
          : 'bg-white border-blue-300 hover:bg-blue-50 hover:border-blue-500 cursor-pointer'
      }`}
    >
      <input
        type="file"
        multiple
        onChange={handleFileInput}
        disabled={isLoading}
        className="hidden"
        id="fileInput"
        accept="application/pdf,image/*"
      />
      <label htmlFor="fileInput" className="cursor-pointer w-full h-full block">
        <div className="flex flex-col items-center justify-center space-y-4">
          <div className="bg-blue-100 p-4 rounded-full">
            <i className="fas fa-cloud-upload-alt text-3xl text-blue-600"></i>
          </div>
          <div>
            <p className="text-lg font-semibold text-gray-700">
              Arraste e solte seus documentos aqui
            </p>
            <p className="text-sm text-gray-500 mt-1">
              Nota Fiscal, SICAF, Termo de Recebimento, Relatórios (PDF ou Imagem)
            </p>
          </div>
          <button
            type="button"
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors pointer-events-none"
          >
            Selecionar Arquivos
          </button>
        </div>
      </label>
    </div>
  );
};

export default FileUploader;
