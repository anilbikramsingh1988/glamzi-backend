🌐 Base URL

http://localhost:3001/api


🔑 Headers

{
  "Content-Type": "application/json",
  "Authorization": "Bearer <your_token_here>"   // (auth required routes only)
}

👤 Auth (User) APIs
1️⃣ Register User

POST /auth/register

Request:
{
  "firstName": "Abdul",
  "lastName": "Bari",
  "phone": "03001234567",
  "email": "abdul@example.com",
  "password": "123456"
}

Response:
{
  "message": "User registered successfully",
  "data": { "id": "66cfabc123", "email": "abdul@example.com" }
}

2️⃣ Login User

POST /auth/login

Request:
{
  "email": "abdul@example.com",
  "password": "123456"
}

Response:
{
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": {
    "_id": "66cfabc123",
    "firstName": "Abdul",
    "lastName": "Bari",
    "email": "abdul@example.com"
  }
}

3️⃣ Forgot Password

POST /auth/forgot-password

Request:
{ "email": "abdul@example.com" }

Response:
{ "message": "Password reset link sent to your email" }

4️⃣ Reset Password

POST /auth/reset-password/:token

Request:
{ "newPassword": "654321" }

Response:
{ "message": "Password reset successfully" }

5️⃣ Get All Users (Admin)

GET /users

Response:
[
  {
    "_id": "66cfabc123",
    "firstName": "Abdul",
    "lastName": "Bari",
    "email": "abdul@example.com",
    "phone": "03001234567"
  }
]

6️⃣ Get Single User (Admin)

GET /users/:id

Response:
{
  "_id": "66cfabc123",
  "firstName": "Abdul",
  "lastName": "Bari",
  "email": "abdul@example.com",
  "phone": "03001234567"
}

7️⃣ Update User (Admin/User)

PUT /users/:id

Request:
{ "firstName": "Updated", "phone": "03009998888" }

Response:
{ "message": "User updated successfully" }

8️⃣ Delete User (Admin)

DELETE /users/:id

Response:
{ "message": "User deleted successfully" }

📦 Product APIs
1️⃣ Create Product

POST /user/product (multipart/form-data)

Request (form-data):
{
  "title": "iPhone 15",
  "description": "Latest iPhone model",
  "price": 200000,
  "categoryId": "66cfcat123",
  "stock": 10,
  "image": "<file>"
}

Response:
{
  "message": "Product added successfully",
  "data": { "id": "66cfprd123", "title": "iPhone 15" }
}

2️⃣ Get All Products

GET /user/products

Response:
[
  {
    "_id": "66cfprd123",
    "title": "iPhone 15",
    "price": 200000,
    "categoryId": "66cfcat123",
    "stock": 10,
    "image": "/uploads/products/iphone.png"
  }
]

3️⃣ Get Single Product

GET /user/product/:id

Response:
{
  "_id": "66cfprd123",
  "title": "iPhone 15",
  "price": 200000,
  "description": "Latest iPhone",
  "stock": 10
}

4️⃣ Update Product

PUT /user/product/:id

Request:
{ "price": 195000, "stock": 12 }

Response:
{ "message": "Product updated successfully" }

5️⃣ Delete Product

DELETE /user/product/:id

Response:
{ "message": "Product deleted successfully" }

🏷️ Category APIs
1️⃣ Create Category

POST /categories

Request:
{ "name": "Mobile Phones" }

Response:
{
  "message": "Category created successfully",
  "data": { "id": "66cfcat123" }
}

2️⃣ Get All Categories

GET /categories

Response:
[
  { "_id": "66cfcat123", "name": "Mobile Phones" },
  { "_id": "66cfcat456", "name": "Laptops" }
]

3️⃣ Update Category

PUT /categories/:id

Request:
{ "name": "Smartphones" }

Response:
{ "message": "Category updated successfully" }

4️⃣ Delete Category

DELETE /categories/:id

Response:
{ "message": "Category deleted successfully" }

📑 Order APIs
1️⃣ Create Order

POST /orders

Request:
{
  "userId": "66cfabc123",
  "products": [
    { "productId": "66cfprd123", "quantity": 2 },
    { "productId": "66cfprd456", "quantity": 1 }
  ],
  "totalAmount": 390000,
  "status": "pending"
}

Response:
{
  "message": "Order created successfully",
  "data": { "id": "66cford123" }
}

2️⃣ Get All Orders

GET /orders

Response:
[
  {
    "_id": "66cford123",
    "userId": "66cfabc123",
    "products": [
      { "productId": "66cfprd123", "quantity": 2 }
    ],
    "totalAmount": 390000,
    "status": "pending"
  }
]

3️⃣ Get Single Order

GET /orders/:id

Response:
{
  "_id": "66cford123",
  "userId": "66cfabc123",
  "products": [
    { "productId": "66cfprd123", "quantity": 2 }
  ],
  "totalAmount": 390000,
  "status": "pending"
}

4️⃣ Update Order Status

PUT /orders/:id

Request:
{ "status": "shipped" }

Response:
{ "message": "Order updated successfully" }

5️⃣ Delete Order

DELETE /orders/:id

Response:
{ "message": "Order deleted successfully" }

