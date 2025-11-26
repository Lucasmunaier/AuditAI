
import React, { useState, useMemo } from 'react';
import FileUploader from './components/FileUploader';
import AuditCard from './components/AuditCard';
import { AuditResult, CheckStatus, ExtractedData, FileWithPreview, LineItem } from './types';
import { analyzeDocuments } from './services/geminiService';
import { fileToBase64, formatDate, formatCurrency } from './utils';

const App: React.FC = () => {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [extractedData, setExtractedData] = useState<ExtractedData | null>(null);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Helper to process files for preview
  const handleFilesSelected = async (newFiles: File[]) => {
    const processedFiles: FileWithPreview[] = await Promise.all(
      newFiles.map(async (file) => ({
        file,
        preview: file.type.startsWith('image') ? await fileToBase64(file) : '',
        type: file.type === 'application/pdf' ? 'pdf' : 'image',
      }))
    );
    setFiles((prev) => [...prev, ...processedFiles]);
    setError(null);
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  // -----------------------------------------------------------------------
  // CORE BUSINESS LOGIC - AUDIT RULES
  // -----------------------------------------------------------------------
  const runAuditRules = (data: ExtractedData): AuditResult[] => {
    const results: AuditResult[] = [];

    // --- 0. Document Validation Check (New Strict Rule) ---
    if (data.informacaoAdministrativa.wrongDocumentDetected) {
        results.push({
            id: 'doc-validation-info-admin',
            title: 'Validação de Documentos',
            description: 'Verificação da integridade e tipologia dos documentos apresentados.',
            status: CheckStatus.FAIL,
            details: 'ERRO DE DOCUMENTAÇÃO: O sistema detectou que o arquivo nomeado ou enviado como "Informação Administrativa" na verdade contém uma Nota Fiscal (DANFE). \n\nIsso indica que o documento correto de justificativa não foi anexado ou houve troca de arquivos.',
            recommendation: 'Verifique os nomes dos arquivos. Remova a Nota Fiscal duplicada e anexe a Informação Administrativa correta.'
        });
    }

    // --- 1. SICAF Check (Detailed) ---
    if (data.sicaf.found && data.termoRecebimento.found && data.termoRecebimento.signatureDate) {
      const signatureDateStr = data.termoRecebimento.signatureDate;
      const signatureDate = new Date(signatureDateStr);
      
      // Define the specific certs we care about
      const certChecks = [
        { key: 'federal_pgfn', label: 'Receita Federal e PGFN', dateStr: data.sicaf.validityDates.federal_pgfn },
        { key: 'fgts', label: 'FGTS', dateStr: data.sicaf.validityDates.fgts },
        { key: 'trabalhista', label: 'Trabalhista', dateStr: data.sicaf.validityDates.trabalhista },
        { key: 'estadual_distrital', label: 'Estadual/Distrital', dateStr: data.sicaf.validityDates.estadual_distrital },
        { key: 'municipal', label: 'Municipal', dateStr: data.sicaf.validityDates.municipal },
      ];

      const subItems = certChecks.map(cert => {
        let status = CheckStatus.PENDING;
        let details = 'Não encontrado';

        if (cert.dateStr) {
            const certDate = new Date(cert.dateStr);
            if (certDate >= signatureDate) {
                status = CheckStatus.PASS;
                details = formatDate(cert.dateStr); // Show valid date
            } else {
                status = CheckStatus.FAIL;
                details = `${formatDate(cert.dateStr)} (Vencido)`;
            }
        } else {
            status = CheckStatus.FAIL;
            details = 'Data não encontrada';
        }

        return { label: cert.label, status, details };
      });

      const hasFailures = subItems.some(i => i.status === CheckStatus.FAIL);

      results.push({
        id: 'sicaf-detailed',
        title: 'Regularidade SICAF',
        description: `Conferência das validades em relação à data de assinatura do Termo (${formatDate(signatureDateStr)}).`,
        status: hasFailures ? CheckStatus.FAIL : CheckStatus.PASS,
        details: hasFailures ? 'Uma ou mais certidões estavam vencidas ou não foram encontradas na data da assinatura.' : 'Todas as certidões estavam vigentes na data da assinatura.',
        recommendation: hasFailures ? 'Solicitar SICAF atualizado ou devolver Nota Fiscal.' : undefined,
        subItems: subItems 
      });

    } else {
        // Fallback if basic docs are missing
        results.push({
            id: 'sicaf-missing',
            title: 'Validação SICAF',
            description: 'Verificação da existência do SICAF e Termo de Recebimento.',
            status: CheckStatus.WARNING,
            details: 'Não foi possível realizar o cruzamento de datas. Verifique se o SICAF e o Termo de Recebimento (com data de assinatura) foram enviados.',
        });
    }

    // --- 2. CNPJ Consistency ---
    const cnpjs = new Set<string>();
    const cnpjSources: string[] = [];
    if (data.notaFiscal.cnpj) { cnpjs.add(data.notaFiscal.cnpj.replace(/\D/g, '')); cnpjSources.push(`NF: ${data.notaFiscal.cnpj}`); }
    if (data.termoRecebimento.cnpj) { cnpjs.add(data.termoRecebimento.cnpj.replace(/\D/g, '')); cnpjSources.push(`Termo: ${data.termoRecebimento.cnpj}`); }
    if (data.sicaf.cnpj) { cnpjs.add(data.sicaf.cnpj.replace(/\D/g, '')); cnpjSources.push(`SICAF: ${data.sicaf.cnpj}`); }

    if (cnpjs.size > 1) {
      results.push({
        id: 'cnpj-match',
        title: 'Consistência de CNPJ',
        description: 'O CNPJ deve ser o mesmo em todos os documentos.',
        status: CheckStatus.FAIL,
        details: `Divergência encontrada:\n${cnpjSources.join('\n')}`,
        recommendation: 'Verificar se os documentos pertencem ao mesmo processo.'
      });
    } else if (cnpjs.size === 1) {
      results.push({
        id: 'cnpj-match',
        title: 'Consistência de CNPJ',
        description: 'Verificação do fornecedor nos documentos.',
        status: CheckStatus.PASS,
        details: `CNPJ ${data.notaFiscal.cnpj || data.termoRecebimento.cnpj} consistente em todos os documentos.`
      });
    }

    // --- 3. Termo de Recebimento "Definitivo" ---
    if (data.termoRecebimento.found) {
      if (data.termoRecebimento.isDefinitive) {
        results.push({
          id: 'tr-definitive',
          title: 'Termo de Recebimento',
          description: 'Verificação do aceite definitivo.',
          status: CheckStatus.PASS,
          details: 'Consta "recebido e aceito definitivamente".'
        });
      } else {
        results.push({
          id: 'tr-definitive',
          title: 'Termo de Recebimento',
          description: 'Verificação do aceite definitivo.',
          status: CheckStatus.FAIL,
          details: 'A expressão "recebido e aceito definitivamente" não foi encontrada. Pode ser um recebimento provisório ou parcial.',
          recommendation: 'Devolver para correção do Termo de Recebimento.'
        });
      }
    }

    // --- 4. Value Check (Gross vs Liquid) ---
    if (data.notaFiscal.found && data.termoRecebimento.found && data.notaFiscal.grossValue !== null && data.termoRecebimento.totalValue !== null) {
      const nfGross = data.notaFiscal.grossValue;
      const nfLiquid = data.notaFiscal.liquidValue;
      const trTotal = data.termoRecebimento.totalValue;

      // Tolerance for float math
      const isMatchGross = Math.abs(nfGross - trTotal) < 0.05;
      
      if (isMatchGross) {
        results.push({
          id: 'value-check-gross',
          title: 'Conferência de Valores',
          description: 'Comparação do Valor Bruto da NF com o Termo de Recebimento.',
          status: CheckStatus.PASS,
          details: `Valor Bruto NF (${formatCurrency(nfGross)}) confere com o Termo de Recebimento (${formatCurrency(trTotal)}).`
        });
      } else {
        // If it doesn't match Gross, check if it matched Liquid (Error Condition)
        if (nfLiquid !== null && Math.abs(nfLiquid - trTotal) < 0.05) {
           results.push({
            id: 'value-check-gross',
            title: 'Conferência de Valores',
            description: 'O Termo de Recebimento deve utilizar o Valor Bruto (Total) da Nota Fiscal.',
            status: CheckStatus.FAIL,
            details: `ERRO CRÍTICO: O Termo de Recebimento está preenchido com o Valor Líquido (${formatCurrency(trTotal)}). Deveria ser o Valor Bruto (${formatCurrency(nfGross)}).`,
            recommendation: 'Corrigir Termo de Recebimento para constar o Valor Total da Nota.'
          });
        } else {
           results.push({
            id: 'value-check-gross',
            title: 'Conferência de Valores',
            description: 'Comparação do Valor Bruto da NF com o Termo de Recebimento.',
            status: CheckStatus.WARNING,
            details: `Divergência de valores. NF Bruto: ${formatCurrency(nfGross)} | TR Total: ${formatCurrency(trTotal)}.`,
            recommendation: 'Verificar se há erro de digitação ou faturamento parcial.'
          });
        }
      }
    }

    // --- 5. Contract Year Logic ---
    if (data.termoRecebimento.found && data.termoRecebimento.bulletinDate && data.termoRecebimento.contractStartYear) {
      const bulletinYear = new Date(data.termoRecebimento.bulletinDate).getFullYear();
      if (bulletinYear < data.termoRecebimento.contractStartYear) {
         results.push({
          id: 'contract-date',
          title: 'Comissão vs Contrato',
          description: 'Validade da comissão de recebimento.',
          status: CheckStatus.FAIL,
          details: `A comissão (Boletim de ${bulletinYear}) é anterior ao início do contrato (${data.termoRecebimento.contractStartYear}).`,
          recommendation: 'Verificar designação da comissão.'
        });
      }
    }

    // --- 6. RMM / Stock Entry Logic (Aggregated & Detailed Line Check) ---
    if (data.notaFiscal.found) {
        if (data.notaFiscal.isMaterial) {
            // It involves materials.
            const hasRmm = data.rmm.found;
            // Only assume valid justification if NO wrong doc was detected
            const hasJustification = data.informacaoAdministrativa.found && data.informacaoAdministrativa.substitutesRmm && !data.informacaoAdministrativa.wrongDocumentDetected;

            if (hasRmm) {
                // RMM Found - Now run Cross-Check on Items with AGGREGATION
                let matchStatus: CheckStatus = CheckStatus.PASS;
                let matchDetails = 'Documento RMM identificado.';
                const subItemsResults: { label: string; status: CheckStatus; details: string }[] = [];

                const normalize = (str: string | null) => str ? str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';

                // Helper to aggregate items by Part Number (or Description if PN missing)
                interface AggregatedItem {
                    totalQty: number;
                    description: string;
                    partNumber: string | null;
                    originalCount: number;
                }

                const aggregateItems = (items: LineItem[]) => {
                    const map = new Map<string, AggregatedItem>();

                    items.forEach(item => {
                        // Priority Key: Normalized PN. Fallback: Normalized First 20 chars of Description
                        let key = '';
                        if (item.partNumber && item.partNumber.length > 2) {
                            key = normalize(item.partNumber);
                        } else {
                            key = normalize(item.description).substring(0, 30);
                        }

                        if (!map.has(key)) {
                            map.set(key, {
                                totalQty: 0,
                                description: item.description,
                                partNumber: item.partNumber,
                                originalCount: 0
                            });
                        }
                        
                        const entry = map.get(key)!;
                        entry.totalQty += item.quantity;
                        entry.originalCount += 1;
                        // Use longest description found
                        if (item.description.length > entry.description.length) {
                            entry.description = item.description;
                        }
                    });
                    return map;
                };

                if (data.notaFiscal.items && data.notaFiscal.items.length > 0) {
                    
                    const nfMap = aggregateItems(data.notaFiscal.items);
                    const rmmMap = aggregateItems(data.rmm.items || []);

                    for (const [key, nfItem] of nfMap) {
                        let rmmMatch: AggregatedItem | undefined = rmmMap.get(key);

                        // If not found by direct key, try fuzzy description match if we relied on PN
                        if (!rmmMatch && nfItem.partNumber) {
                             const nfDescTokens = nfItem.description.toLowerCase().split(' ').filter(w => w.length > 3);
                             // Iterate rmmMap values
                             for (const rItem of rmmMap.values()) {
                                const rDesc = rItem.description.toLowerCase();
                                const isFuzzyMatch = nfDescTokens.some(token => rDesc.includes(token));
                                if (isFuzzyMatch) {
                                    rmmMatch = rItem;
                                    break;
                                }
                             }
                        }

                        const label = `${nfItem.partNumber || 'S/N'} - ${nfItem.description.substring(0, 30)}...`;

                        if (rmmMatch) {
                            if (Math.abs(rmmMatch.totalQty - nfItem.totalQty) < 0.01) { // Float tolerance
                                subItemsResults.push({
                                    label: label,
                                    status: CheckStatus.PASS,
                                    details: `Qtd Total NF: ${nfItem.totalQty} = Qtd Total RMM: ${rmmMatch.totalQty}`
                                });
                            } else {
                                subItemsResults.push({
                                    label: label,
                                    status: CheckStatus.WARNING,
                                    details: `Divergência Qtd: NF(${nfItem.totalQty}) vs RMM(${rmmMatch.totalQty})`
                                });
                                if (matchStatus !== CheckStatus.FAIL) matchStatus = CheckStatus.WARNING;
                            }
                        } else {
                            subItemsResults.push({
                                label: label,
                                status: CheckStatus.FAIL,
                                details: 'Item não encontrado no RMM'
                            });
                            matchStatus = CheckStatus.FAIL;
                        }
                    }

                    if (matchStatus === CheckStatus.FAIL) matchDetails = 'Alguns itens da Nota Fiscal não foram encontrados no RMM.';
                    else if (matchStatus === CheckStatus.WARNING) matchDetails = 'Itens encontrados, mas com divergência de quantidade acumulada.';
                    else matchDetails = 'Todos os itens da Nota Fiscal foram conferidos no RMM com sucesso.';

                } else {
                    matchStatus = CheckStatus.WARNING;
                    matchDetails = 'RMM encontrado, mas não foi possível extrair a lista de itens da NF para cruzamento.';
                }

                results.push({
                    id: 'rmm-check-detailed',
                    title: 'Conferência Detalhada: NF vs RMM',
                    description: 'Comparação item a item (agrupada por PN) entre Nota Fiscal e Relação de Materiais.',
                    status: matchStatus,
                    details: matchDetails,
                    subItems: subItemsResults.length > 0 ? subItemsResults : undefined
                });

            } else if (hasJustification) {
                results.push({
                    id: 'rmm-check',
                    title: 'Entrada em Estoque (RMM)',
                    description: 'Conferência de entrada de material em estoque.',
                    status: CheckStatus.PASS,
                    details: 'Não há RMM, mas foi encontrada Informação Administrativa justificando a não entrada em estoque (consumo imediato ou substituição RMM).',
                });
            } else {
                 results.push({
                    id: 'rmm-check',
                    title: 'Entrada em Estoque (RMM)',
                    description: 'Materiais devem ter comprovante de entrada em estoque.',
                    status: CheckStatus.FAIL,
                    details: 'A Nota Fiscal contém itens de material/consumo, mas não foi encontrado RMM nem Informação Administrativa justificando a ausência.',
                    recommendation: 'Solicitar RMM ou Informação Administrativa justificando.'
                });
            }
        } else if (data.notaFiscal.isService && !data.notaFiscal.isMaterial) {
            // Only services.
             results.push({
                id: 'rmm-check',
                title: 'Entrada em Estoque',
                description: 'Verificação de necessidade de RMM.',
                status: CheckStatus.PASS,
                details: 'Nota Fiscal identificada como Serviço. RMM não é obrigatório.'
            });
        }
    }

    // --- 7. ND Consistency (Service vs Material) ---
    if (data.relatorioFatura.found && data.relatorioFatura.empenhos.length > 0) {
        const serviceNDs = data.relatorioFatura.empenhos.filter(e => e.nd.includes('339039'));
        
        if (serviceNDs.length > 0 && data.notaFiscal.isMaterial) {
            if (data.informacaoAdministrativa.found && data.informacaoAdministrativa.justifiesServiceND && !data.informacaoAdministrativa.wrongDocumentDetected) {
                 results.push({
                    id: 'nd-consistency',
                    title: 'Natureza de Despesa (ND)',
                    description: 'Compatibilidade da ND com o objeto da NF.',
                    status: CheckStatus.PASS,
                    details: `Uso de ND de Serviço (339039) para materiais devidamente justificado pela Informação Administrativa.`,
                });
            } else if (data.informacaoAdministrativa.found && !data.informacaoAdministrativa.wrongDocumentDetected) {
                results.push({
                    id: 'nd-consistency',
                    title: 'Natureza de Despesa (ND)',
                    description: 'Compatibilidade da ND com o objeto da NF.',
                    status: CheckStatus.PASS,
                    details: `Nota com materiais usando ND de Serviço. Informação Administrativa presente (presume-se justificativa).`,
                });
            } else {
                results.push({
                    id: 'nd-consistency',
                    title: 'Natureza de Despesa (ND)',
                    description: 'Verificar compatibilidade da ND com o objeto da NF.',
                    status: CheckStatus.WARNING,
                    details: `Identificado empenho com ND de Serviço (339039) para uma Nota Fiscal que contém materiais, sem Informação Administrativa justificando (ex: material aplicado em serviço).`,
                    recommendation: 'Verificar necessidade de Informação Administrativa para justificar o uso do empenho.'
                });
            }
        }
    }

    return results;
  };

  const handleAnalyze = async () => {
    if (files.length === 0) return;
    setIsAnalyzing(true);
    setAuditResults([]);
    setError(null);

    try {
      const rawFiles = files.map(f => f.file);
      const data = await analyzeDocuments(rawFiles);

      // --- FAILSAFE LOGIC FOR CNPJ ---
      if (data.termoRecebimento.found && data.termoRecebimento.cnpj && data.notaFiscal.found) {
        const trCnpj = data.termoRecebimento.cnpj.replace(/\D/g, '');
        const currentNfCnpj = data.notaFiscal.cnpj ? data.notaFiscal.cnpj.replace(/\D/g, '') : '';

        if (trCnpj !== currentNfCnpj && data.notaFiscal.possibleCnpjs && data.notaFiscal.possibleCnpjs.length > 0) {
            const match = data.notaFiscal.possibleCnpjs.find(c => c.replace(/\D/g, '') === trCnpj);
            if (match) {
                console.log(`[Auto-Correct] Replacing NF CNPJ ${data.notaFiscal.cnpj} with verified Supplier CNPJ ${match} from TR match.`);
                data.notaFiscal.cnpj = match;
            }
        }
      }

      setExtractedData(data);
      const results = runAuditRules(data);
      setAuditResults(results);
    } catch (err) {
      console.error(err);
      setError("Ocorreu um erro ao analisar os documentos. Certifique-se de que os arquivos estão nítidos e contêm as informações necessárias.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setExtractedData(null);
    setAuditResults([]);
    setError(null);
  }

  // Memoize mismatch calculations for sidebar display
  const { isTrMismatch, isEmpenhosMismatch } = useMemo(() => {
    if (!extractedData || !extractedData.notaFiscal.grossValue) return { isTrMismatch: false, isEmpenhosMismatch: false };
    
    const nfVal = extractedData.notaFiscal.grossValue;
    const trVal = extractedData.termoRecebimento.totalValue;
    
    // Use the specific 'Total Fatura' if available, otherwise sum empenhos (fallback)
    const relatorioVal = extractedData.relatorioFatura.totalValue !== null 
        ? extractedData.relatorioFatura.totalValue 
        : (extractedData.relatorioFatura.found ? extractedData.relatorioFatura.empenhos.reduce((acc, curr) => acc + curr.value, 0) : 0);

    // Tolerance for float comparison
    const isTrMismatch = trVal !== null && Math.abs(nfVal - trVal) > 0.05;
    // If we have either totalValue or empenhos, check mismatch
    const isEmpenhosMismatch = (extractedData.relatorioFatura.totalValue !== null || extractedData.relatorioFatura.empenhos.length > 0) && Math.abs(nfVal - relatorioVal) > 0.05;

    return { isTrMismatch, isEmpenhosMismatch };
  }, [extractedData]);

  return (
    <div className="min-h-screen pb-12 bg-slate-50">
      {/* Header */}
      <header className="bg-slate-850 text-white shadow-lg sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 p-2 rounded-lg">
                <i className="fas fa-file-invoice-dollar text-xl"></i>
            </div>
            <h1 className="text-xl font-bold tracking-tight">AuditAI <span className="font-normal text-gray-400">| Auditor Fiscal</span></h1>
          </div>
          <div>
            <button onClick={reset} className="text-sm text-gray-300 hover:text-white transition-colors">
              Nova Análise
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Intro / Upload Section */}
        {auditResults.length === 0 && !extractedData && (
            <div className="max-w-5xl mx-auto">
                <div className="text-center mb-8">
                    <h2 className="text-3xl font-bold text-gray-900 mb-2">Conferência Automatizada</h2>
                    <p className="text-gray-600">
                        Auditoria de Notas Fiscais, SICAF, RMM e Termos de Recebimento.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                    {/* Upload Area */}
                    <div className="md:col-span-7 lg:col-span-8">
                         <FileUploader onFilesSelected={handleFilesSelected} isLoading={isAnalyzing} />
                         {error && (
                            <div className="mt-4 p-4 bg-red-100 border border-red-300 text-red-800 rounded-lg animate-fade-in">
                                <i className="fas fa-exclamation-circle mr-2"></i> {error}
                            </div>
                        )}
                    </div>

                    {/* Compact File List & Action */}
                    <div className="md:col-span-5 lg:col-span-4 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-full max-h-[400px]">
                        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                            <h3 className="font-semibold text-gray-700 text-sm">Arquivos ({files.length})</h3>
                            {files.length > 0 && <button onClick={() => setFiles([])} className="text-xs text-red-500 hover:text-red-700">Limpar</button>}
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-2 space-y-2">
                            {files.length === 0 ? (
                                <div className="h-32 flex flex-col items-center justify-center text-gray-400 text-sm italic">
                                    <span>Nenhum arquivo selecionado</span>
                                </div>
                            ) : (
                                files.map((f, idx) => (
                                    <div key={idx} className="flex items-center p-2 hover:bg-gray-50 rounded border border-transparent hover:border-gray-200 group">
                                        <div className="w-8 h-8 flex flex-shrink-0 items-center justify-center bg-gray-100 rounded text-gray-500 mr-3">
                                            <i className={`fas ${f.type === 'pdf' ? 'fa-file-pdf text-red-500' : 'fa-file-image text-blue-500'}`}></i>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-gray-700 truncate">{f.file.name}</p>
                                            <p className="text-xs text-gray-400">{(f.file.size / 1024).toFixed(1)} KB</p>
                                        </div>
                                        <button onClick={() => removeFile(idx)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity px-2">
                                            <i className="fas fa-times"></i>
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="p-4 border-t border-gray-100 bg-gray-50">
                             <button
                                onClick={handleAnalyze}
                                disabled={isAnalyzing || files.length === 0}
                                className={`w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg font-bold text-white shadow-sm transition-all ${
                                    isAnalyzing || files.length === 0 
                                    ? 'bg-gray-400 cursor-not-allowed' 
                                    : 'bg-green-600 hover:bg-green-700 hover:shadow-md'
                                }`}
                            >
                                {isAnalyzing ? (
                                    <>
                                        <i className="fas fa-circle-notch fa-spin"></i>
                                        <span>Analisando...</span>
                                    </>
                                ) : (
                                    <>
                                        <i className="fas fa-check-double"></i>
                                        <span>Auditar</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Results Section */}
        {extractedData && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* Left Column: Data Extraction Summary */}
                <div className="lg:col-span-1 space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sticky top-24">
                        <div className="border-b pb-4 mb-4">
                            <h3 className="text-lg font-bold text-gray-800">
                                {extractedData.notaFiscal.found 
                                  ? `NF ${extractedData.notaFiscal.number || 'N/A'}` 
                                  : 'Nota Fiscal'}
                            </h3>
                            {extractedData.notaFiscal.supplierName && (
                                <p className="text-sm text-gray-600 mt-1 uppercase font-medium">{extractedData.notaFiscal.supplierName}</p>
                            )}
                        </div>
                        
                        <div className="space-y-5">
                            {/* Nota Fiscal Data Details */}
                             {extractedData.notaFiscal.found && (
                                <div className="text-sm text-gray-600 space-y-1">
                                    <div className="flex justify-between">
                                        <span className="font-semibold text-gray-500">CNPJ:</span> 
                                        <span className="font-mono text-gray-900">{extractedData.notaFiscal.cnpj}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="font-semibold text-gray-500">Emissão:</span> 
                                        <span className="text-gray-900">{formatDate(extractedData.notaFiscal.emissionDate)}</span>
                                    </div>
                                    {extractedData.notaFiscal.grossValue && (
                                        <div className="flex justify-between border-t border-gray-100 pt-1 mt-1">
                                            <span className="font-bold text-gray-700">Valor Bruto:</span> 
                                            <span className="font-bold text-gray-900">{formatCurrency(extractedData.notaFiscal.grossValue)}</span>
                                        </div>
                                    )}
                                </div>
                             )}

                            {/* Relatorio Fatura Details */}
                            <div>
                                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2 flex items-center">
                                    Relatório Fatura
                                    {extractedData.relatorioFatura.found && <i className="fas fa-check text-green-500 ml-2"></i>}
                                </h4>
                                {extractedData.relatorioFatura.found ? (
                                    <div className="text-sm bg-gray-50 p-3 rounded border border-gray-100 space-y-2">
                                        <div className="grid grid-cols-2 gap-2 text-xs border-b border-gray-200 pb-2">
                                            <div>
                                                <span className="block text-gray-500 font-semibold">Emissão:</span>
                                                <span className="font-bold text-gray-900">{formatDate(extractedData.relatorioFatura.emissionDate)}</span>
                                            </div>
                                            <div>
                                                <span className="block text-gray-500 font-semibold">Chegada:</span>
                                                <span className="font-bold text-gray-900">{formatDate(extractedData.relatorioFatura.arrivalDate)}</span>
                                            </div>
                                            <div>
                                                <span className="block text-gray-500 font-semibold">Vencimento:</span>
                                                <span className="font-bold text-gray-900">{formatDate(extractedData.relatorioFatura.dueDate)}</span>
                                            </div>
                                        </div>
                                        
                                        {/* Total Fatura Explicit Display */}
                                        {extractedData.relatorioFatura.totalValue && (
                                            <div className="flex justify-between border-b border-gray-200 py-2">
                                                <span className="text-gray-600 font-semibold">Total Fatura:</span> 
                                                <span className={`font-bold ${isEmpenhosMismatch ? 'text-red-600' : 'text-gray-900'}`}>
                                                    {formatCurrency(extractedData.relatorioFatura.totalValue)}
                                                </span>
                                            </div>
                                        )}

                                        <div className="pt-1">
                                            {extractedData.relatorioFatura.empenhos.map((emp, i) => (
                                                <div key={i} className="text-xs flex justify-between items-center py-1">
                                                    <div>
                                                        <span className="block font-bold text-blue-800">NE {emp.ne}</span>
                                                        <span className="text-gray-600 font-medium">ND {emp.nd}</span>
                                                    </div>
                                                    {/* Only show individual values if we don't have a specific Total Fatura, or for detail */}
                                                    {!extractedData.relatorioFatura.totalValue && (
                                                        <span className={`font-mono font-semibold ${isEmpenhosMismatch ? 'text-red-600' : 'text-gray-900'}`}>{formatCurrency(emp.value)}</span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : <span className="text-sm text-red-500 italic">Não encontrado</span>}
                            </div>

                            {/* Termo de Recebimento Data */}
                            <div>
                                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2 flex items-center">
                                    Termo de Recebimento
                                    {extractedData.termoRecebimento.found && <i className="fas fa-check text-green-500 ml-2"></i>}
                                </h4>
                                {extractedData.termoRecebimento.found ? (
                                    <div className="text-sm bg-gray-50 p-3 rounded border border-gray-100 space-y-2">
                                        <div className="flex justify-between">
                                            <span className="text-gray-600 font-semibold">Assinatura:</span> 
                                            <span className="font-bold text-gray-900">{formatDate(extractedData.termoRecebimento.signatureDate)}</span>
                                        </div>
                                         <div className="flex justify-between">
                                            <span className="text-gray-600 font-semibold">Valor Total:</span> 
                                            <span className={`font-bold ${isTrMismatch ? 'text-red-600' : 'text-green-700'}`}>
                                                {extractedData.termoRecebimento.totalValue ? formatCurrency(extractedData.termoRecebimento.totalValue) : 'N/A'}
                                            </span>
                                        </div>
                                         {extractedData.termoRecebimento.contractNumber && (
                                            <div className="flex justify-between">
                                                <span className="text-gray-600 font-semibold">Contrato:</span> 
                                                <span className="font-bold text-gray-900">{extractedData.termoRecebimento.contractNumber}</span>
                                            </div>
                                         )}
                                    </div>
                                ) : <span className="text-sm text-red-500 italic">Não encontrado</span>}
                            </div>

                             {/* Docs Tags */}
                             <div className="pt-2 border-t">
                                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Checklist Documentos</h4>
                                <div className="flex flex-wrap gap-2">
                                   <span className={`px-2 py-1 rounded text-xs font-bold border ${extractedData.sicaf.found ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>SICAF</span>
                                   <span className={`px-2 py-1 rounded text-xs font-bold border ${extractedData.rmm.found ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>RMM</span>
                                   <span className={`px-2 py-1 rounded text-xs font-bold border ${extractedData.informacaoAdministrativa.found && !extractedData.informacaoAdministrativa.wrongDocumentDetected ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>Info. Admin</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Audit Results */}
                <div className="lg:col-span-2 space-y-4">
                     <div className="flex justify-between items-center mb-2">
                        <h3 className="text-2xl font-bold text-gray-900">Parecer da Auditoria</h3>
                        <div className="space-x-2">
                             <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                                {auditResults.filter(r => r.status === CheckStatus.PASS).length} OK
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">
                                {auditResults.filter(r => r.status === CheckStatus.FAIL).length} Erro
                            </span>
                        </div>
                     </div>

                    {auditResults.map(result => (
                        <AuditCard key={result.id} result={result} />
                    ))}

                    <div className="mt-8 pt-8 border-t border-gray-200">
                        <button onClick={reset} className="text-blue-600 font-semibold hover:text-blue-800 flex items-center bg-white px-4 py-2 rounded-lg shadow-sm border border-gray-200">
                            <i className="fas fa-arrow-left mr-2"></i> Realizar nova auditoria
                        </button>
                    </div>
                </div>
            </div>
        )}

      </main>
    </div>
  );
};

export default App;
