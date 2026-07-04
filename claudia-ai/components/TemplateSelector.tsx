interface TemplateSelectorProps {
  onSelect: (template: string) => void;
}

const templates = [
  {
    id: "react-app",
    name: "React Application",
    description: "Modern React app with hooks and components",
    emoji: "⚛️",
    color: "from-blue-500 to-cyan-500",
  },
  {
    id: "nextjs-app",
    name: "Next.js Application",
    description: "Full-stack React framework with SSR",
    emoji: "▲",
    color: "from-gray-700 to-gray-900",
  },
  {
    id: "node-api",
    name: "Node.js API",
    description: "RESTful API with Express.js",
    emoji: "🟢",
    color: "from-green-500 to-emerald-500",
  },
  {
    id: "landing-page",
    name: "Landing Page",
    description: "Beautiful responsive landing page",
    emoji: "🎨",
    color: "from-purple-500 to-pink-500",
  },
  {
    id: "dashboard",
    name: "Admin Dashboard",
    description: "Data visualization and management",
    emoji: "📊",
    color: "from-orange-500 to-red-500",
  },
  {
    id: "ecommerce",
    name: "E-commerce Store",
    description: "Online store with cart and checkout",
    emoji: "🛒",
    color: "from-indigo-500 to-purple-500",
  },
];

export default function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="text-center mb-12">
        <h2 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          Choose Your Template
        </h2>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          Select a starting point for your project, or start from scratch
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {templates.map((template) => (
          <button
            key={template.id}
            onClick={() => onSelect(template.id)}
            className="group relative p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-2xl transition-all duration-300 transform hover:scale-105 text-left border border-gray-200 dark:border-gray-700"
          >
            <div
              className={`absolute inset-0 bg-gradient-to-br ${template.color} opacity-0 group-hover:opacity-10 rounded-2xl transition-opacity duration-300`}
            ></div>
            
            <div className="relative">
              <div className="text-4xl mb-4">{template.emoji}</div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {template.name}
              </h3>
              <p className="text-gray-600 dark:text-gray-400">
                {template.description}
              </p>
            </div>
          </button>
        ))}
      </div>

      <div className="text-center">
        <button
          onClick={() => onSelect("blank")}
          className="px-8 py-4 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-semibold rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors border-2 border-dashed border-gray-300 dark:border-gray-600"
        >
          Start from Blank Canvas
        </button>
      </div>
    </div>
  );
}
