const PopularProducts = ({ products }) => {
  const maxSales = Math.max(...products.map(p => p.sales));

  return (
    <div className="bg-white rounded-xl shadow-md p-6 w-full">
      <h3 className="text-xl font-semibold text-gray-700 mb-4">이번달 인기 상품 Top 5</h3>
      <ul className="space-y-4">
        {products.map((product, index) => {
          const percentage = Math.round((product.sales / maxSales) * 100);
          return (
            <li key={index} className="flex items-center gap-4">
              <img src={product.image} alt={product.name} className="w-12 h-12 object-cover rounded" />
              <div className="flex-1">
                <div className="flex justify-between text-sm font-medium text-gray-700 mb-1">
                  <span>{product.name}</span>
                  <span>{product.sales}개</span>
                </div>
                <div className="w-full h-2 bg-gray-200 rounded">
                  <div className="h-2 bg-blue-500 rounded" style={{ width: `${percentage}%` }}></div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PopularProducts;
