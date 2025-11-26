
export enum CheckStatus {
  PENDING = 'PENDING',
  PASS = 'PASS',
  FAIL = 'FAIL',
  WARNING = 'WARNING',
}

export interface AuditResult {
  id: string;
  title: string;
  description: string;
  status: CheckStatus;
  details?: string; // Markdown supported
  recommendation?: string;
  subItems?: { label: string; status: CheckStatus; details: string }[];
}

export interface SicafDates {
  federal_pgfn: string | null;
  fgts: string | null;
  trabalhista: string | null;
  estadual_distrital: string | null;
  municipal: string | null;
}

export interface LineItem {
  description: string;
  partNumber: string | null;
  quantity: number;
  unit: string | null;
}

export interface ExtractedData {
  sicaf: {
    found: boolean;
    cnpj: string | null;
    validityDates: SicafDates;
  };
  termoRecebimento: {
    found: boolean;
    cnpj: string | null;
    signatureDate: string | null;
    isDefinitive: boolean;
    bulletinDate: string | null;
    hasContractReference: boolean;
    contractStartYear: number | null;
    totalValue: number | null;
    contractNumber: string | null;
  };
  notaFiscal: {
    found: boolean;
    number: string | null;
    supplierName: string | null;
    cnpj: string | null;
    possibleCnpjs: string[]; // List of all CNPJs found in the document
    emissionDate: string | null;
    grossValue: number | null; // VALOR TOTAL DA NOTA (Bruto)
    liquidValue: number | null; // VALOR LÍQUIDO (com descontos)
    isMaterial: boolean;
    isService: boolean;
    items: LineItem[];
  };
  relatorioFatura: {
    found: boolean;
    emissionDate: string | null;
    arrivalDate: string | null;
    dueDate: string | null;
    totalValue: number | null; // Added specific Total Fatura field
    empenhos: {
      ne: string;
      nd: string;
      value: number;
    }[];
  };
  rmm: {
    found: boolean;
    items: LineItem[];
  };
  informacaoAdministrativa: {
    found: boolean;
    substitutesRmm: boolean; 
    justifiesServiceND: boolean; // Explicitly justifies using Service ND for materials
    justification: string | null;
    wrongDocumentDetected: boolean; // Flag if a DANFE/NF is found instead of Info Admin
  };
}

export interface FileWithPreview {
  file: File;
  preview: string;
  type: 'pdf' | 'image';
}
