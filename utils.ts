
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the Data URL prefix (e.g., "data:image/jpeg;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

export const formatDate = (dateString: string | null): string => {
  if (!dateString) return 'N/A';
  try {
    // Handle YYYY-MM-DD (ISO) coming from JSON
    const [year, month, day] = dateString.split('-');
    if (year && month && day) {
        return `${day}/${month}/${year}`;
    }
    // Fallback for other formats
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('pt-BR').format(date);
  } catch (e) {
    return dateString;
  }
};

export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
};
