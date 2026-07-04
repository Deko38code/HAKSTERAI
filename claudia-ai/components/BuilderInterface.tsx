"use client";

import { useState } from "react";
import ChatInterface from "./ChatInterface";
import CodePreview from "./CodePreview";
import TemplateSelector from "./TemplateSelector";

interface BuilderInterfaceProps {
  onBack: () => void;
}

export default function BuilderInterface({ onBack }: BuilderInterfaceProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [generatedCode, setGeneratedCode] = useState<string>("");
  const [showTemplates, setShowTemplates] = useState(true);

  const handleTemplateSelect = (template: string) => {
    setSelectedTemplate(template);
    setShowTemplates(false);
  };

  const handleCodeGenerate = (code: string) => {
    setGeneratedCode(code);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              ← Back
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-600 to-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-xl font-bold text-white">C</span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                Claudia AI Builder
              </h1>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Templates
            </button>
            <button className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors">
              Export Code
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      {showTemplates ? (
        <TemplateSelector onSelect={handleTemplateSelect} />
      ) : (
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[calc(100vh-120px)]">
            {/* Chat Interface */}
            <div className="flex flex-col">
              <ChatInterface
                selectedTemplate={selectedTemplate}
                onCodeGenerate={handleCodeGenerate}
              />
            </div>

            {/* Code Preview */}
            <div className="flex flex-col">
              <CodePreview code={generatedCode} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
