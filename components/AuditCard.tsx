
import React from 'react';
import { AuditResult, CheckStatus } from '../types';

interface AuditCardProps {
  result: AuditResult;
}

const AuditCard: React.FC<AuditCardProps> = ({ result }) => {
  const getStatusColor = (status: CheckStatus) => {
    switch (status) {
      case CheckStatus.PASS:
        return 'bg-green-50 border-green-200 text-green-800'; // Darkened text color
      case CheckStatus.FAIL:
        return 'bg-red-50 border-red-200 text-red-800'; // Darkened text color
      case CheckStatus.WARNING:
        return 'bg-yellow-50 border-yellow-200 text-yellow-800'; // Darkened text color
      default:
        return 'bg-gray-50 border-gray-200 text-gray-800';
    }
  };

  const getIcon = (status: CheckStatus) => {
    switch (status) {
      case CheckStatus.PASS:
        return <i className="fas fa-check-circle text-xl text-green-600"></i>;
      case CheckStatus.FAIL:
        return <i className="fas fa-times-circle text-xl text-red-600"></i>;
      case CheckStatus.WARNING:
        return <i className="fas fa-exclamation-triangle text-xl text-yellow-600"></i>;
      default:
        return <i className="fas fa-spinner fa-spin text-xl text-gray-400"></i>;
    }
  };

  return (
    <div className={`border rounded-lg p-4 mb-3 transition-all ${getStatusColor(result.status)}`}>
      <div className="flex items-start justify-between">
        <div className="flex gap-3 w-full">
            <div className="mt-1 flex-shrink-0">{getIcon(result.status)}</div>
            <div className="w-full">
                <h3 className="font-semibold text-lg">{result.title}</h3>
                <p className="text-sm opacity-90 mt-1">{result.description}</p>
                
                {result.details && (
                    <div className="mt-3 text-sm bg-white/60 p-3 rounded border border-black/5 leading-relaxed whitespace-pre-wrap text-gray-800">
                        <span className="font-bold text-gray-900">Análise: </span> {result.details}
                    </div>
                )}

                {/* Sub Items (e.g., SICAF details or Cross-check items) */}
                {result.subItems && result.subItems.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                        {result.subItems.map((item, idx) => (
                             <div key={idx} className={`text-sm p-2 rounded flex flex-col md:flex-row md:items-center justify-between border ${item.status === CheckStatus.PASS ? 'bg-green-100/50 border-green-200 text-green-900' : item.status === CheckStatus.WARNING ? 'bg-yellow-100/50 border-yellow-200 text-yellow-900' : 'bg-red-100/50 border-red-200 text-red-900'}`}>
                                <span className="font-medium mr-2 truncate flex-1">{item.label}</span>
                                <div className="flex items-center gap-2 mt-1 md:mt-0 flex-shrink-0">
                                    <span className="text-xs font-semibold bg-white/50 px-2 py-0.5 rounded">{item.details}</span>
                                    {item.status === CheckStatus.PASS ? 
                                        <i className="fas fa-check text-green-700"></i> : 
                                        item.status === CheckStatus.WARNING ?
                                        <i className="fas fa-exclamation text-yellow-700"></i> :
                                        <i className="fas fa-times text-red-700"></i>
                                    }
                                </div>
                             </div>
                        ))}
                    </div>
                )}
                
                {result.status !== CheckStatus.PASS && result.recommendation && (
                    <div className="mt-3 pt-2 border-t border-black/10 text-sm font-semibold text-gray-900">
                        <i className="fas fa-arrow-right mr-1"></i> Ação: {result.recommendation}
                    </div>
                )}
            </div>
        </div>
      </div>
    </div>
  );
};

export default AuditCard;
