"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface ChatInterfaceProps {
  selectedTemplate: string;
  onCodeGenerate: (code: string) => void;
}

export default function ChatInterface({
  selectedTemplate,
  onCodeGenerate,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content: `Hello! I'm Claudia, your AI coding assistant. You've selected the "${selectedTemplate}" template. Tell me what you'd like to build, and I'll help you create it!`,
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);

    // Simulate AI response
    setTimeout(() => {
      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `I understand you want to ${input}. Let me generate the code for you...`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiMessage]);
      setIsTyping(false);

      // Generate sample code
      const sampleCode = `// Generated code for: ${input}
import React from 'react';

function App() {
  return (
    <div className="container">
      <h1>Your Application</h1>
      <p>Building: ${input}</p>
    </div>
  );
}

export default App;`;
      onCodeGenerate(sampleCode);
    }, 1500);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700">
      {/* Chat Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Chat with Claudia
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Describe what you want to build
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                message.role === "user"
                  ? "bg-gradient-to-r from-purple-600 to-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              }`}
            >
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              <span
                className={`text-xs mt-1 block ${
                  message.role === "user"
                    ? "text-purple-100"
                    : "text-gray-500 dark:text-gray-400"
                }`}
              >
                {message.timestamp.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex justify-start">
            <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl px-4 py-3">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                <div
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.1s" }}
                ></div>
                <div
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                ></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Describe your application..."
            className="flex-1 px-4 py-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-600 text-gray-900 dark:text-gray-100 resize-none"
            rows={2}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-xl hover:shadow-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
