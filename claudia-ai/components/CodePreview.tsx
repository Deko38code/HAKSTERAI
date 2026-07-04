"use client";

import { useState } from "react";

interface CodePreviewProps {
  code: string;
}

export default function CodePreview({ code }: CodePreviewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generated-code.js";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Generated Code
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Preview and export your code
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            onClick={handleDownload}
            disabled={!code}
            className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Download
          </button>
        </div>
      </div>

      {/* Code Display */}
      <div className="flex-1 overflow-auto p-6">
        {code ? (
          <pre className="text-sm font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 p-4 rounded-xl overflow-x-auto">
            <code>{code}</code>
          </pre>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-gray-600">
            <div className="text-center">
              <div className="text-6xl mb-4">💻</div>
              <p className="text-lg">Your generated code will appear here</p>
              <p className="text-sm mt-2">
                Start chatting with Claudia to generate code
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer Stats */}
      {code && (
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
          <span>{code.split("\n").length} lines</span>
          <span>{code.length} characters</span>
        </div>
      )}
    </div>
  );
}
