interface HeroProps {
  onGetStarted: () => void;
}

export default function Hero({ onGetStarted }: HeroProps) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
      <div className="absolute inset-0 bg-grid-pattern opacity-5"></div>
      
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-20 text-center">
        <div className="mb-8 inline-block">
          <div className="w-20 h-20 mx-auto bg-gradient-to-br from-purple-600 to-blue-600 rounded-2xl flex items-center justify-center shadow-2xl transform hover:scale-110 transition-transform duration-300">
            <span className="text-4xl font-bold text-white">C</span>
          </div>
        </div>

        <h1 className="text-6xl md:text-7xl font-bold mb-6 bg-gradient-to-r from-purple-600 via-blue-600 to-purple-600 bg-clip-text text-transparent animate-gradient">
          Claudia AI
        </h1>
        
        <p className="text-2xl md:text-3xl text-gray-700 dark:text-gray-300 mb-4 font-light">
          Your AI-Powered Application Builder
        </p>
        
        <p className="text-lg md:text-xl text-gray-600 dark:text-gray-400 mb-12 max-w-2xl mx-auto leading-relaxed">
          Transform your ideas into reality with the power of artificial intelligence. 
          Build web applications, APIs, and more through natural conversation.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16">
          <button
            onClick={onGetStarted}
            className="px-8 py-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white text-lg font-semibold rounded-xl shadow-lg hover:shadow-2xl transform hover:scale-105 transition-all duration-300"
          >
            Start Building
          </button>
          
          <button className="px-8 py-4 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-lg font-semibold rounded-xl shadow-lg hover:shadow-2xl transform hover:scale-105 transition-all duration-300 border border-gray-200 dark:border-gray-700">
            View Examples
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-2xl transition-shadow duration-300">
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900 rounded-xl flex items-center justify-center mb-4 mx-auto">
              <span className="text-2xl">💬</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-200">
              Natural Conversation
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Describe what you want to build in plain English
            </p>
          </div>

          <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-2xl transition-shadow duration-300">
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-xl flex items-center justify-center mb-4 mx-auto">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-200">
              Instant Generation
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Watch your application come to life in real-time
            </p>
          </div>

          <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-2xl transition-shadow duration-300">
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900 rounded-xl flex items-center justify-center mb-4 mx-auto">
              <span className="text-2xl">🚀</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-200">
              Export & Deploy
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Download your code and deploy anywhere
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        .bg-grid-pattern {
          background-image: 
            linear-gradient(to right, #8080801a 1px, transparent 1px),
            linear-gradient(to bottom, #8080801a 1px, transparent 1px);
          background-size: 40px 40px;
        }
        
        @keyframes gradient {
          0%, 100% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
        }
        
        .animate-gradient {
          background-size: 200% auto;
          animation: gradient 3s ease infinite;
        }
      `}</style>
    </div>
  );
}
